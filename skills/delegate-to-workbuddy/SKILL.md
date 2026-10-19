---
name: delegate-to-workbuddy
description: 当需要把有明确范围的本机任务交给 WorkBuddy（腾讯桌面 agent，自带 CodeBuddy CLI）执行时使用：一次派发、盯到终态、自己复核证据、按完整 sessionId 归档。适用于「让 WorkBuddy 去做 / 让 WorkBuddy 核对 / 并行跑几个只读核查」这类请求。
---

# 派活给 WorkBuddy

## 什么时候用

- 任务范围明确、能在本机工作区里独立完成（实现、核对、调研、批量处理）。
- 你想用 WorkBuddy 的模型/技能，而不是当前会话的模型。
- 需要一次**可验收**的委派：结论 + 证据 + 归档，而不是「它说做完了」。

不要用于：一句话就能答的问题、需要频繁来回确认的探索、需要读取用户未授权目录的任务。

## 铁律

1. **只给路径和范围，不贴内容**：源码、diff、zip 不进任务文本，让 WorkBuddy 自己读工作区。
2. **必须等到终态**：`wb_wait_run` 返回 `hostMustCallWaitRunAgain: true` 就是没结束，继续等；超时不是终态。
3. **自己复核**：读 `assistantText` 不够，用 `wb_read_session` 或直接读文件核对行号与结论。
4. **验收后才归档**：只归档这次新建的那个完整 `sessionId`；`archived:false` 时如实报告原因，不要重试到「成功」为止。
5. **不绕过安装**：原生工具缺失就修安装，不要自己拼 JSON-RPC 或直接调 CLI。

## 标准流程

```text
1) wb_doctor                      → 确认 found:true、cliEntry、modelSource
2) wb_list_capabilities           → 确认真实可用的模型与权限模式
3) wb_start_review  （只读）      → runId + sessionId
   wb_start_run     （实施）      → 同上，任务里写明允许改哪些文件
4) wb_wait_run { runId }          → 反复调用直到 terminal:true
5) 复核：assistantText + wb_read_session + 自己打开文件对证据
6) wb_archive_session { sessionId, project }  → archived:true + sha256
```

## 顺带能回答的问题：WorkBuddy 定时任务怎么了

用户问「定时任务跑没跑 / 为什么没触发 / 最近有没有失败」时，不要去翻日志文件，直接读桌面调度器（只读）：

```text
wb_automation_health                      → 生效 vs 软删、总运行、失败率、失败码、过期未触发
wb_list_automations { includeDeleted }    → 节奏、next_run、最近一次、模型、权限、推送
wb_get_automation_runs { automationId, failuresOnly }  → 单任务运行历史与失败码
```

两条铁律：

- **活性看 `deleted_at`，不看 `status`**：软删除行的 `status` 仍是 `ACTIVE`（本工具包已给出 `live` / `softDeleted` 两个字段）。
- **prompt 是用户的私有内容**：默认不返回；只有用户明确要看时才 `includePrompt: true`，并且不要把正文大段复制进回答。
- 只读。**禁止**为了“修一下”而改数据库或新增/删除任务——那要走桌面 UI 或它的 IPC。

## 任务文本模板

**只读核对**

```text
只读核对 <文件/目录> 的 <章节或问题>：给出精确文件与行号证据、影响面、最小修复建议、置信度；
无法验证的部分明确标为未验证。不要修改或创建任何文件。
```

**明确授权的实施**

```text
修复 <文件> 中已确认的 <问题>。只允许修改 <文件A> 与 <测试文件B>，运行 <测试命令> 并回报结果；
不要提交、不要 push、不要碰其他文件。
```

**长任务 / 多轮**

```text
继续 <上次 runId 或 sessionId>：把 <新增要求> 补进去，仍然只改 <范围>，完成后给出改动路径与测试结果。
```

## 失败怎么读

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `stopReason: authentication-required` | 无头 CLI 用不了桌面登录态 | 传 `model`（见 `wb_list_capabilities`）或设 `DWB_DEFAULT_MODEL` |
| `state: unknown` + `process-exited-without-result` | 进程没了但没等到 result 事件 | 用 `sessionFile` 直接看转录，别当成功 |
| `archived:false / session-may-be-active` | 转录刚写过，本工具包没有它的终态记录 | 等它结束；确实已结束再 `force:true` |
| `archived:false / session-not-terminal` | 转录里没有完成记录 | 任务可能被中断，重派或人工核对 |
| `hostMustCallWaitRunAgain: true` | 还在跑 | 继续 `wb_wait_run`，别宣布完成 |

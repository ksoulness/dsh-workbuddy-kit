# 安全与边界

这个工具包给一个**本地桌面 agent** 加了一条程序化通道。它提高的是可验收性，不是隔离性。以下是明确的边界。

## 权限声明 ≠ 沙箱

`wb_start_review` 用 `--permission-mode plan` 并拒绝 `Write`、`Edit`、`NotebookEdit`。这是**给模型的声明**，由 WorkBuddy CLI 自己的策略执行；它不是操作系统级沙箱。CLI 以自己的用户权限运行，`Bash`/`PowerShell` 之类的工具能做什么取决于 CLI 自己的判断。

实测证据：一次只读派发里，模型报「Bash 权限被拒，已改用 Grep/Read 完成」——策略确实生效了，但那是因为 CLI 执行了它，而不是本工具包拦住了它。

要真正的隔离，用沙箱化的 host 或 CLI 自带的 `--sandbox`，并自己验证。

## 派发内容

任务文本会发给 WorkBuddy 所用的模型与端点。因此：

- 只写工作区、范围、授权、验收标准；
- 不要把源码、diff、压缩包、密钥贴进任务文本；
- `promptPreview` 会进入本地台账（截断到 4000 字符），`promptSha256` 只留指纹。

## 凭据

- 不读取、不打印、不落盘 token / cookie / API key / keyblob；
- `models.json` 只取 `id`、`vendor`、`supportsToolCall` 这类身份字段，`apiKey` 从不离开文件；
- 无头 CLI 需要模型凭据时，由 CLI 自己从 WorkBuddy 数据目录取，本工具包不接触；
- 归档与台账里只有路径、大小、SHA-256、会话 id、模型 id。

## 归档的三种拒绝

归档是**唯一写厂商目录**的操作，且默认 `copy`。它在下列情况下拒绝并给出原因，不会伪造成功：

| 拒绝原因 | 触发条件 |
| --- | --- |
| `session-is-active` | 本工具包台账里有该 sessionId 的非终态派发 |
| `session-may-be-active` | 转录 `mtime` 在活跃窗口内（默认 120s）且台账里没有它的终态记录 |
| `session-not-terminal` | 转录里没有完成记录（`requireTerminal` 默认 `true`） |
| `target-exists` | 归档目标已存在（除非 `overwrite: true`） |
| `session-not-found` | `<configDir>/projects/*` 下找不到该 id |

`move` 模式会移动厂商转录，属于显式的、可逆的破坏性操作；桌面端的「已归档」索引不会被本工具包修改。

## 终态 ≠ 任务完成

state: succeeded 只说明**这次 CLI 运行干净结束**（stopReason: end_turn）。它不代表任务做成了。实测过三次：

- 工作区外读文件被拒（即使加了 -y，跨 --add-dir 目录的读取仍被拦），模型诚实回答「无法完成」→ 运行层 succeeded，实际零改动；
- 工作区内读+写正常 → 文件确实生成，逐字核对通过。

所以本工具包给的是**证据**，不是判决：workspaceChanges（git porcelain 前后对比）、	oolCalls、ssistantText、sessionFile。注意 workspaceChanges 只覆盖非 ignore 路径——写进 .local/ 这类 gitignore 目录时它会显示「无变化」，此时必须直接看文件。

## 调度器只读

桌面调度器（`workbuddy.db` 的三张 automation 表）只用 `readOnly: true` 打开。理由不是洁癖：桌面进程持有内存中的调度状态，直写 sqlite 会让它的界面与库不一致，甚至把下一次触发时间算错。

- 不写、不删、不改任何调度行；
- 任务 prompt 是用户的私有长文本，默认只返回 `promptBytes`；显式 `includePrompt: true` 也截断到 2000 字符；
- 运行历史只做聚合（成功率、失败码计数），不把 `thread_title` 全文倒出来（默认 300 字符预览，可关）。

## 进程与文件

- 只从 `<configDir>`（只读）、`<stateDir>`（本工具包）、`<configDir>/session-archive`（归档目标）三处读写；
- 派发 `cwd` 必须是已存在的目录，且由调用方显式给出；
- 取消时终止整棵子进程树，且只有进程确实消失才写 `cancelled`；
- 不安装、不升级、不改 WorkBuddy 的任何配置或数据库。

## 责任边界

本包不是腾讯、DeepSeek 官方产品。WorkBuddy/CodeBuddy 的行为、额度、条款由腾讯决定；模型读取的内容由所选提供商按其条款处理。本包只负责：把一次委派变成可观察、可复核、可归档的事件。

## 发布到桌面 App 索引（唯一写库操作）

`wb_publish_session` 会向 `workbuddy.db` 的 `sessions` / `session_usage` 各插一行，让 CLI 派发的会话出现在桌面 App 的会话列表里。这是本工具包**唯一**写厂商数据的路径。

- 写前先备份：`Copy-Item workbuddy.db workbuddy.db.bak-<时间戳>`（本机库约 186 MB，拷贝几秒）；
- 只插一行，事务提交，`PRAGMA busy_timeout=8000`，桌面 App 正在运行也能写；
- 插了什么记进 `<stateDir>/published.jsonl`；`wb_unpublish_session` 只删自己插的行；
- 不改转录、不删会话、不同步云端；
- 桌面 App 若已打开，可能需要切一下会话列表或重启才会刷新。

# DSH WorkBuddy Kit

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen.svg)](https://nodejs.org) [![MCP](https://img.shields.io/badge/MCP-stdio-8A2BE2.svg)](https://modelcontextprotocol.io)

> **DeepSeek Harness 负责想清楚并验收，本机 WorkBuddy 负责动手做：一次派发、等到终态、自己复核证据、按完整 sessionId 归档。**

一个本机工具包，把「DSH 派活」和「WorkBuddy 干活」接成闭环。两个前门共用同一张工具表：

- **原生 DSH 工具**（Cordis 插件 `dsh-workbuddy-kit`，注册 `wb_*` 到 `ctx.tools`）
- **stdio MCP 服务**（`dsh-workbuddy-mcp`，任何 MCP 客户端可用）

两者行为完全一致，因为它们调用的是同一份 `src/tools.mjs`。

## 它控制的是什么

本机 WorkBuddy 桌面版（腾讯，实测 `5.8.3`）在自己的安装目录里**自带一个 CodeBuddy agent CLI**：

```text
D:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\
  bin\codebuddy          # @genie/agent-cli 入口（实测 2.161.0）
  dist\codebuddy-lite-wb.mjs  # 当前发行只带 lite-wb 包
```

这个 CLI 支持无头运行：`-p/--print`、`--output-format stream-json`、`--session-id`、`--permission-mode`、`--model`、`--max-turns`、`--effort`、`--mcp-config`……本工具包就是把这条通道变成一组可验收的工具：

| 工具 | 作用 |
| --- | --- |
| `wb_doctor` | 只读自检：CLI、Node、数据目录、版本、自定义模型、最近是否撞到登录墙 |
| `wb_list_capabilities` | 真实可用的 permission mode / 自定义模型 |
| `wb_list_projects` / `wb_list_sessions` | 找到 WorkBuddy 的工程目录与会话 |
| `wb_start_review` | **只读**派发（`--permission-mode plan`，并拒绝 Write/Edit/NotebookEdit） |
| `wb_start_run` | 实施派发（默认 `acceptEdits`） |
| `wb_wait_run` / `wb_get_run` | 盯到终态；超时**不算**终态（`hostMustCallWaitRunAgain`） |
| `wb_cancel_run` | 终止整个子进程树 |
| `wb_list_runs` | 本机派发台账 |
| `wb_read_session` | 直接读对话记录（消息、工具调用、模型），自己复核 |
| `wb_archive_session` | 按完整 sessionId 归档：带 SHA-256 的副本 + manifest + 索引 |
| `wb_list_automations` | **桌面 App 调度器**：定时任务清单（节奏/下次触发/最近结果/模型/权限/推送） |
| `wb_get_automation_runs` | 某个定时任务的运行历史、成功率、失败码 |
| `wb_automation_health` | 调度器体检：生效 vs 软删、总运行/失败率、失败码分布、过期未触发 |

调度器三个工具**只读** `workbuddy.db`（`automations` / `automation_runs` / `automation_runtime_state`），不写任何调度状态。

## 最后效果

真实跑过一次的形态（这就是本仓库在制作机上的验收记录）：

```text
你   ❯ 用 WorkBuddy 只读核对 notes.md 里的标记，别改文件

DSH ❯ wb_start_review { workspace:"E:\\Code\\demo",
                        task:"读出形如 DWB-ACCEPT-XXXX 的标记，原样引用，不要修改任何文件" }
      → runId, sessionId:<uuid>, permissionMode:"plan", state:"running"
      wb_wait_run { runId }      → state:"succeeded", stopReason:"end_turn", toolCalls:3, durationMs:22485
      （assistantText 里就是 "DWB-ACCEPT-9F3A，位于第 3 行"，自己去文件对一遍）
      wb_archive_session { sessionId:"<uuid>" }
      → archived:true, bytes:15124, sha256:a0c6cc74…, target:…\\session-archive\\2026-10-19\\e-Code-demo\\
```

拿到的不是「已完成」四个字，而是：结论 + 工具调用次数 + 真实 sessionId + 归档摘要。

## 安装

前置：本机已装 WorkBuddy 桌面版；Node ≥ 22.19（跑 DSH 用，本工具包自身零依赖）。

### A. 原生 DSH 工具（推荐）

```sh
git clone <this repo> dsh-workbuddy-kit
cd dsh-workbuddy-kit
dsh plugin --profile web add .
dsh --profile web --dump-config | grep -n workbuddy
```

重启 DSH（Web 端刷新页面）后，`wb_*` 就是原生工具。

### B. MCP stdio（任何 MCP 客户端）

`cordis.patch.yml` 里追加一行，不要在同一个 profile 同时开 A 和 B（工具名会重复）：

```yaml
- id: mcp-workbuddy
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: workbuddy
    transport: stdio
    command: node
    args: ['E:\\Code\\dsh-workbuddy-kit\\mcp\\server.mjs']
```

### C. 手工验证（不接任何客户端）

```sh
node bin/wb.mjs doctor
node bin/wb.mjs review --workspace E:\Code\demo --task "只读核对 README 第 1 节，给出精确行号" --wait 300
node bin/wb.mjs sessions --limit 5
```

## 关键约束（都是实测出来的，不是猜的）

- **CLI 必须指向 WorkBuddy 的数据目录**：不设 `CODEBUDDY_CONFIG_DIR` / `WORKBUDDY_CONFIG_DIR`，CLI 会去读 `~/.codebuddy`，那里没有登录态。本工具包自动指向 `~/.workbuddy`。
- **当前发行只带 `lite-wb` 包**：必须带 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`，否则启动器会去找不存在的 `dist/codebuddy`。工具包自动判定。
- **无头 CLI 用不了桌面版的登录态**：账号默认模型会直接返回 `Authentication required`。工具包默认挑 `<configDir>/models.json` 里的第一个自定义模型（本机实测 `custom-local:cn:space-bunny` 可用），并把这个选择记在 `modelSource` 里；用 `DWB_DEFAULT_MODEL` 可覆盖。
- **无头下工具调用要 `-y`**：腾讯文档明确「`-y` 是非交互模式必需参数」，否则读写/命令会被拦（本仓库实测：`plan` 模式下 Bash 被拒，模型改走 Grep/Read）。`wb_start_run` 提供显式的 `skipPermissions: true`，从不默认打开；HIGH/CRITICAL 命令仍可能要求确认。
- **会话落在 `<configDir>/projects/<工程名>/<sessionId>.jsonl`**，工程名是工作目录的映射（`E:\Code\acme-app` → `e-Code-acme-app`）。归档就是对这个文件做带摘要的副本。
- **归档不动厂商数据**：默认 `copy`，WorkBuddy 自己的会话列表不变；`move` 是显式的可逆选项。

## 桌面 App 的调度器（定时任务）

定时任务**不在文件里**，在 `~/.workbuddy/workbuddy.db` 的三张表（`automations.db` 是 0 字节的遗留空文件）：

| 表 | 内容 |
| --- | --- |
| `automations` | 任务定义：名字、完整 prompt、状态、`rrule`、`next_run_at`、`last_run_at`、模型、权限模式、工作区、推送渠道、`deleted_at` |
| `automation_runs` | 每次触发：`thread_id`、状态、`result_success`、`failure_code`、`reason_code`、标题 |
| `automation_runtime_state` | `running`、`last_error` |

```sh
node bin/wb.mjs automations              # 生效中的任务
node bin/wb.mjs automations --all        # 含软删除
node bin/wb.mjs automations --prompt     # 附带 prompt 预览（默认不返回）
node bin/wb.mjs automation-runs --name "研究流水线监护" --limit 5 --failures
node bin/wb.mjs automation-health
```

两个必须知道的坑（实测）：

- **软删除行 `status` 仍是 `ACTIVE`**：真正的活性信号是 `deleted_at`。本工具包输出 `softDeleted` 与 `live` 两个显式字段，避免把僵尸任务当活跃任务。
- **prompt 全文就在库里**（很长、很私人）：默认只返回 `promptBytes`，要预览得显式 `includePrompt: true`，且截断到 2000 字符。

读法是 `readOnly: true` 打开 SQLite（WAL 读者不影响正在运行的桌面 App）。**不做写操作**：暂停/改 RRULE/新建/删除都要走桌面自己的 IPC（`\\.\pipe\wbipc-…`）或 UI，直写 sqlite 会让界面与库不一致。

## 与已有项目的关系

搜过一圈，方向不同，没有一个在做「DSH 派活给 WorkBuddy 并验收」：

| 项目 | 它做什么 | 与本仓库的区别 |
| --- | --- | --- |
| [`dsh-connect-workbuddy`](https://dsh.directory/plugins/dingminhua/dsh-connect-workbuddy) / [`corrinehu/dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) | 把 WorkBuddy 的**模型**接进 DSH 模型选择器 + 账号池/积分 | 解决「用哪个模型」，不涉及把任务交给 WorkBuddy agent 执行 |
| [`ithtelab/workbuddy-manager`](https://github.com/ithtelab/workbuddy-manager) | WorkBuddy/CodeBuddy 账号池 + OpenAI 兼容反代（`workbuddy2api`） | 网关与账号运维，不是 agent 委派 |
| 腾讯官方 [无头模式文档](https://www.workbuddy.ai/docs/zh/cli/headless) | `-p` / `--output-format` / `--resume` 等 CLI 用法 | 只用 CLI，无派发台账、无终态机、无会话归档 |
| [`ksoulness/dsh-codex-kit`](https://github.com/ksoulness/dsh-codex-kit) | Codex → DSH 的委派（本仓库的结构参照） | 方向相反：本仓库是 DSH → WorkBuddy |

## 安全与边界

- `permissionMode: plan` 与拒绝写工具是**给模型的声明**，不是进程级沙箱：CLI 仍以自己的权限运行，Bash 之类的工具能做什么由它自己的策略决定。
- 派发内容是「任务描述」，不是源码：只说工作区、范围、授权、验收标准，让 WorkBuddy 自己去读文件。
- 不读取、不打印、不落盘任何 token / cookie / API key；`models.json` 只取 `id`、`vendor` 这类身份字段。
- 归档在会话仍活跃、或本工具包没有该会话的终态记录、或目标文件已存在时会**拒绝**并给出原因，不伪造 `archived:true`。
- 本包不是腾讯 / DeepSeek 官方产品。

## 已验证 / 未验证

制作机（Windows、Node `v24.19.0`、WorkBuddy `5.8.3`、CLI `2.161.0`、DSH `0.2.1-alpha.2`）实测：

- ✅ 真实只读派发 → `succeeded` / `end_turn` / 3 次工具调用 / 22.5s，`assistantText` 与工作区文件一致；
- ✅ 真实实施派发 → `succeeded` / `end_turn`，工作区里确实多出 `hello.txt`，内容与任务要求逐字一致（`DWB-RUN-OK`）；
- ✅ 真实归档两次：`archived:true`，15124 / 7973 字节，`sha256:a0c6cc74…` / `9887ba08…`；
- ✅ `wb_doctor` 正确识别安装路径、自带 Node、`liteBundleOnly`、自定义模型；
- ✅ `node --test` 50/50：流解析、工程名映射、schema 子集、MCP 握手、归档的全部拒绝分支、调度器只读读取（含软删除与失败码）、git 侧改动证据；
- ✅ MCP stdio 真实握手（`initialize` + `tools/list`）；
- ✅ 在真实 cordis 里挂载插件（`inject: ['tools']`）→ 15 个工具全部通过 `dsh-tools` 自己的 `assertObjectJsonSchema` / `assertSupportedJsonSchema` 校验（`npm run verify`）；
- ✅ 委派真实产出：WorkBuddy 按任务在 `E:\Code\demo` 写出 `CHEATSHEET.md`，其中 5 条命令逐字核对全部命中源文档（`README.md:71/72/85/94/95`）；另一次运行由 `workspaceChanges` 抓到新增 `demo-workspace-change.md`（`addedCount: 1`）；
- ✅ 诚实的失败样本：跨 `--add-dir` 目录读取被拦（即使 `-y`），运行层仍 `succeeded` 但零改动 —— 证明「终态 ≠ 完成」，必须看 `workspaceChanges` / 文件；
- ✅ 桌面调度器真实读取：6 条生效 + 3 条软删、1110 次运行（1015 成功 / 95 失败，成功率 0.9144）、失败码分布与本机 WorkBuddy 界面一致；
- ✅ `dsh plugin --profile web add .` 装进本机 profile，`dsh --profile web --dump-config` 出现 `dsh-workbuddy-kit` 行。

未验证：其他 WorkBuddy 版本 / 其他平台的路径、`--acp` 与 `--serve` 通道、`move` 归档对桌面端索引的影响。

## 目录结构

```text
src/discover.mjs    安装/CLI/Node/数据目录定位，工程名映射
src/cli.mjs         组装无头调用、spawn、终止进程树
src/parse.mjs       stream-json 与 session JSONL 解析
src/runs.mjs        派发台账、终态判定、恢复与取消
src/sessions.mjs    会话枚举/读取/精确归档
src/automations.mjs 桌面调度器只读（automations / runs / runtime_state）
src/tools.mjs       唯一工具表（两个前门共用）
plugin/index.mjs    原生 DSH 插件
mcp/server.mjs      stdio MCP 服务（零依赖）
bin/wb.mjs          手工 CLI
cordis.patch.yml    DSH bundle 层（只插一行）
skills/delegate-to-workbuddy/SKILL.md
docs/               接入、架构、安全
tests/              37 个 node:test 用例
```

## 文档

- [接入与故障定位](docs/setup.md)
- [架构与状态机](docs/architecture.md)
- [安全与边界](docs/security.md)
- [DSH 交接清单](DSH-HANDOFF.md)

## 许可

MIT。WorkBuddy、CodeBuddy、DeepSeek Harness 不在本包内，各按其自身许可与条款。

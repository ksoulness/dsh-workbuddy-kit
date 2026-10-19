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

## 进程与文件

- 只从 `<configDir>`（只读）、`<stateDir>`（本工具包）、`<configDir>/session-archive`（归档目标）三处读写；
- 派发 `cwd` 必须是已存在的目录，且由调用方显式给出；
- 取消时终止整棵子进程树，且只有进程确实消失才写 `cancelled`；
- 不安装、不升级、不改 WorkBuddy 的任何配置或数据库。

## 责任边界

本包不是腾讯、DeepSeek 官方产品。WorkBuddy/CodeBuddy 的行为、额度、条款由腾讯决定；模型读取的内容由所选提供商按其条款处理。本包只负责：把一次委派变成可观察、可复核、可归档的事件。

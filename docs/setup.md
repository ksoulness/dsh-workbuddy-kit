# 接入与故障定位

## 三条接入路线

### A. 原生 DSH 工具（推荐）

```sh
cd <repo>
dsh plugin --profile <profile> add .
dsh --profile <profile> --dump-config | grep -n workbuddy
```

`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，它只**插入一行**：

```yaml
- insert:
    - id: dsh-workbuddy-kit
      name: 'dsh-workbuddy-kit'
```

所以它不会替换任何 Harness 产品行、provider、沙箱或权限配置。装完需要让 DSH 重新加载（Web 端刷新页面；必要时重启 `dsh web`），`wb_*` 才会出现在工具列表里。

### B. MCP stdio（任何 MCP 客户端）

DSH 用官方 `@deepseek-ai/dsh-mcp-client` 挂载：

```yaml
- id: mcp-workbuddy
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: workbuddy
    transport: stdio
    command: node
    args: ['E:\\Code\\dsh-workbuddy-kit\\mcp\\server.mjs']
    env:
      DWB_STATE_DIR: 'E:\\Code\\dsh-workbuddy-kit\\.local\\state'
```

工具名会带命名空间（`workbuddy_wb_doctor` 之类）。**不要**在同一个 profile 里同时用 A 和 B：同一批工具注册两次会让模型看到重复能力。

### C. 手工 CLI（不接任何客户端）

```sh
node bin/wb.mjs doctor
node bin/wb.mjs capabilities
node bin/wb.mjs projects
node bin/wb.mjs sessions --limit 5
node bin/wb.mjs review --workspace <dir> --task "<任务>" --wait 300 --archive
node bin/wb.mjs run    --workspace <dir> --task "<任务>" --wait 300
node bin/wb.mjs wait --run <runId>
node bin/wb.mjs archive --session <sessionId> --project <工程名>
```

所有输出都是 JSON；命令非零退出只表示命令本身失败，WorkBuddy 跑失败是**数据**（`state: failed`）。

## 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `DWB_CONFIG_DIR` | `~/.workbuddy`（或 `WORKBUDDY_CONFIG_DIR` / `CODEBUDDY_CONFIG_DIR`） | WorkBuddy 数据目录 |
| `DWB_CLI_DIR` | 自动探测安装目录 | 指向 `<install>/resources/app.asar.unpacked/cli` |
| `DWB_STATE_DIR` | `~/.dsh-workbuddy` | 本工具包的派发台账 |
| `DWB_DEFAULT_MODEL` | `<configDir>/models.json` 的第一个自定义模型 | 无头 CLI 用的模型 |

## 故障表

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `WorkBuddy CLI not found` | 安装路径不在候选里 | 设 `DWB_CLI_DIR` |
| `Cannot find module '../dist/codebuddy'` | 少了 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` | 本工具包会自动加；手工跑 CLI 时自己加 |
| `Authentication required` | 无头 CLI 拿不到桌面登录态 | 传 `model`（自定义模型）或 `DWB_DEFAULT_MODEL` |
| 工具调用被拒（`Bash` 之类） | 无头模式默认不授予工具权限；腾讯文档要求 `-y` | `wb_start_run` 传 `skipPermissions: true`（显式、不默认开） |
| `state: unknown` / `no-result-event` | 进程退出但没有 `result` 事件 | 看 `streamLog`、`stderrLog` 与 `sessionFile` |
| `session-not-found` | 会话不在 `<configDir>/projects/*` 下 | 用 `wb_list_sessions` 确认 sessionId 与工程名 |
| `session-may-be-active` | 转录刚写过且无本工具包终态记录 | 等结束；确认结束后 `force: true` |
| 归档成功但桌面端看不到「已归档」 | 预期行为 | 本工具包用 copy 归档，不改厂商索引 |

## 关于 `--acp` / `--serve`

CLI 还提供 `--acp`（Agent Client Protocol over stdio）与 `--serve`（HTTP + REST）。当前实现走 `-p --output-format stream-json`，因为它在一个进程内给出确定性的终态事件与 sessionId；换通道不会改变工具表语义，但需要另写一套适配与测试，本仓库暂未验证。

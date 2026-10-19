# 架构与状态机

## 一条派发的生命

```text
wb_start_review / wb_start_run
   │  discover()            读安装路径、CLI、Node、数据目录（只读）
   │  buildInvocation()     组装 -p --output-format stream-json …（含 env）
   │  journal: queued       <state>/runs/<runId>.json 原子写
   │  spawn                 <node> <cli> …  cwd=workspace
   │  journal: running      pid 落盘
   │  system/init 事件       捕获 sessionId → 会话文件路径
   │  返回 runId            （最多等 8s 拿 sessionId，拿不到也照常返回）
   ▼
wb_wait_run（可反复调用）
   │  每 500ms 读台账；发现 pid 已消失则 reconcile
   │  result 事件 → succeeded / failed（stopReason=end_turn 或错误子类型）
   ▼
terminal: succeeded | failed | cancelled | unknown
   │
   ├─ wb_read_session  ← 自己复核证据
   └─ wb_archive_session → 带 SHA-256 的副本 + manifest + 索引
```

`stateSource` 永远标出来源：

- `observation`：本次进程里真的看到了 `result` 事件；
- `transcript`：进程没了，但会话转录里有完成记录（恢复）；
- `process-exit`：进程没了也没有完成记录 → `unknown`，**不当作成功**。

## 为什么台账放外面

WorkBuddy 的数据目录是厂商资产：`settings.json`、`workbuddy.db`、`sessions/`、`session-archive/`。本工具包：

- **只读**厂商目录（`models.json` 只取非敏感身份字段）；
- 自己的台账写在 `~/.dsh-workbuddy/runs/`（可用 `DWB_STATE_DIR` 改）；
- 归档默认 `copy` 到 `<configDir>/session-archive/<date>/<project>/`，这是 WorkBuddy 自己也会用的归档位置，但从不删除或重写厂商索引。

## 终止语义

- Windows：`taskkill /pid <pid> /T /F`（整棵树）。
- POSIX：先 `SIGTERM` 给进程组，宽限期后 `SIGKILL`。
- 取消是**观察**：只有 `process.kill(pid, 0)` 证明进程没了，才写 `state: cancelled`。

## 解析器

`src/parse.mjs` 处理两种同源格式：

1. 实时流：`system/init`、`assistant`、`user`、`result`；
2. 落盘转录：`type: message` + `role` + `content[]`（`input_text` / `output_text` / `tool_use` / `tool_result`），外加 `file-history-snapshot` 这类元数据行。

转录摘要走**头尾读**（默认头 256 KiB、尾 1 MiB），所以 5 MB 的历史会话不会拖慢 `wb_list_sessions`。

## 幂等

`idempotencyKey` → `runId = wb-<sha256(key)[0:16]>`。同一个键重复派发返回同一条台账（`idempotentReplay: true`），不会二次调用模型。`state: cancelled` 的键可以被复用。

## 两个前门为什么不会漂移

`src/tools.mjs` 是唯一工具表：

```js
{ name, description, parameters, output: { schema, render }, handler }
```

- 原生插件：`ctx.tools.register({ name, description, parameters, output, execute })`
- MCP 服务：`tools/list` 直接投影成 `inputSchema`，`tools/call` 调同一个 `handler`

`tests/mcp.test.mjs` 会检查每个 schema 都落在 Harness 支持的 JSON Schema 子集里（`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解），所以新增工具不可能只在一侧生效或用了 DSH 会拒绝的关键字。

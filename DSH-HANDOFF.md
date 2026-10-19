# DSH 交接清单

给下一个接手这个仓库的 agent 或人：先做这五步，再动代码。

## 1. 确认真实环境

```sh
node bin/wb.mjs doctor
```

要看到的字段（值会因机器而异）：

- `found: true`
- `cliEntry` 指向 `<install>/resources/app.asar.unpacked/cli/bin/codebuddy`
- `nodeBinary` 指向 WorkBuddy 自带的 Node
- `liteBundleOnly: true`（当前发行）
- `customModels` 非空 → 这是无头派发能用的模型
- `authentication.authenticated`：`false` 表示最近有派发撞到登录墙

## 2. 跑测试

```sh
npm test          # 37 个用例，零依赖
```

## 3. 做一次真实只读验收

```sh
node bin/wb.mjs review --workspace <一个你允许它读的目录> \
  --task "只读核对 <文件> 的 <章节>，给出精确行号；不要修改任何文件" --wait 300
```

必须看到 `state: "succeeded"` 且 `stopReason: "end_turn"`，然后**自己打开文件**核对 `assistantText` 里的行号/引用对不对。

## 4. 归档这次会话

```sh
node bin/wb.mjs archive --session <sessionId> --project <projectSlug>
```

要拿到 `archived: true` + 64 位 `sha256`。若返回 `session-may-be-active`，说明台账里还没有这次派发的终态记录——先确认 `wb_get_run` 是终态。

## 5. 接进 DSH 并确认注册

```sh
dsh plugin --profile web add .          # 先备份 package.json / pnpm-lock.yaml / cordis.patch.yml
dsh --profile web --dump-config | grep -n workbuddy
```

重载 DSH 后确认 `wb_*` 出现在工具列表。同一 profile 不要同时挂 MCP 版本。

## 改代码时不要做的事

- 不要新增 DSH 工具 schema 关键字（只允许 `type/oneOf/properties/required/additionalProperties/items/enum/const` + `description/title/default/examples`），`tests/mcp.test.mjs` 会拦。
- 不要让 MCP 与原生插件各写一份 handler（都从 `src/tools.mjs` 取）。
- 不要把「超时」当终态，也不要在没有 `result` 事件时写 `succeeded`。
- 不要为了「让验收过」而放宽归档的三种拒绝条件。
- 不要在文档里写没跑过的结论；未验证的写进「未验证」。

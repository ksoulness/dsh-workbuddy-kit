# AGENTS.md — install and verify this kit, by an AI agent

You are an AI agent with shell access on the user's machine. Your job: install **dsh-workbuddy-kit**, verify it really works, and report evidence. Do not claim success you have not observed.

Repository: <https://github.com/ksoulness/dsh-workbuddy-kit>
What it is: a DeepSeek Harness (DSH) plugin (+ an optional skill, an MCP stdio server, and a CLI) that lets DSH dispatch bounded tasks to the local WorkBuddy desktop app, wait for a terminal state, read the evidence, and archive the exact session. All four shapes share one tool table (`src/tools.mjs`).

## 0. Rules you must follow

1. **Never fabricate a result.** If a step fails, report the exact command and the exact error.
2. **Do not escalate permissions.** No `sudo`, no "run as administrator", no `bypassPermissions` for WorkBuddy dispatches, no disabling antivirus/policy, no `npm i -g --force`.
3. **Do not modify the user's WorkBuddy state.** Never write `workbuddy.db`, never edit `models.json`, never touch `projects/*.jsonl`. The kit has one opt-in write path (`wb_publish_session`) — do not call it during installation.
4. **Ask before anything destructive.** Rollbacks, deleting directories, or rewriting git history require explicit user consent.
5. **Report what you actually ran**, with the observed output, not a summary of what should have happened.

## 1. Preflight (all must pass)

```sh
node -v          # need >= 22.19 (the kit uses node:sqlite)
git --version
dsh --version    # the DSH CLI; if missing, stop and tell the user
```

Detect the WorkBuddy installation (read-only) before promising anything:

```sh
# Windows
dir "C:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\bin"
# macOS
ls "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin"
```

If that directory is absent, the kit cannot work: report it and stop.

## 2. Install (try in this order; record which one worked)

```sh
git clone https://github.com/ksoulness/dsh-workbuddy-kit.git
cd dsh-workbuddy-kit
```

**Route A — native DSH plugin (preferred).** Ask the user which profile to install into; the default web profile is usually `web`.

```sh
dsh plugin --profile <profile> add .
dsh --profile <profile> --dump-config | grep -i dsh-workbuddy-kit   # the row must appear
```

**Route B — offline tarball.** Download the release asset instead of cloning:

```sh
npm i -g ./dsh-workbuddy-kit-<version>.tgz
dwb doctor
```

**Route C — MCP stdio only** (no DSH): add to the client config, then restart that client.

```json
{
  "mcpServers": {
    "workbuddy": { "command": "node", "args": ["<absolute-path>/mcp/server.mjs"] }
  }
}
```

**Route D — no install at all**, for a manual check:

```sh
node bin/wb.mjs doctor
```

## 3. Verification (do all of it; paste real output)

```sh
npm test                 # expect: pass 65, fail 0
npm run verify           # expect: registeredTools 18, failures []
node bin/wb.mjs doctor    # expect: found true, cliEntry …, liteBundleOnly as reported
```

MCP framing check (must be valid JSON on stdout, nothing else):

```sh
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node mcp/server.mjs
```

Expect `serverInfo.name = dsh-workbuddy-kit`, `protocolVersion = 2025-06-18`, and **18 tools**.

Restart requirement: a DSH profile snapshots its tool table at boot. After Route A, tell the user to **restart DSH**, then confirm the 18 `wb_*` tools are available. Adding or removing a tool always needs a restart; editing a tool's implementation does not.

## 4. Optional first dispatch (only if the user asked for it)

```sh
node bin/wb.mjs run --task "read README.md and quote its first heading" --wait 300
```

Report `runId`, `state`, `stopReason`, `toolCalls`, `workspaceChanges`, and quote `assistantText`. Then check the quoted content yourself — `state: succeeded` means the process ended cleanly, **not** that the task was done correctly.

## 5. Report back with this shape

| Step | Command | Observed result | Verdict |
| --- | --- | --- | --- |
| preflight | `node -v` | v22.22.2 | ok |
| install | `dsh plugin --profile web add .` | row appears in `--dump-config` | ok |
| tests | `npm test` | pass 65 / fail 0 | ok |
| contract | `npm run verify` | 18 tools, 0 failures | ok |
| self-check | `node bin/wb.mjs doctor` | found true, appVersion 5.8.3 | ok |

End with: what still needs a human (restart DSH), what you could not verify, and any error you hit verbatim.

## 6. Known limitations (state them, do not paper over them)

- Verified only against WorkBuddy **5.8.3** with the bundled **lite-wb** CodeBuddy CLI on **Windows**.
- The headless CLI cannot use the desktop login, so the account-default model fails; the kit falls back to a custom model from `<configDir>/models.json`.
- Under `acceptEdits`, cross-directory reads and `WebFetch`/`curl` are blocked, and `WebSearch` is unavailable headless. Use `bypassPermissions` only if the user explicitly agrees.
- Git-ignored paths are invisible to the `workspaceChanges` check; read the file instead.

## 7. Rollback

```sh
dsh plugin --profile <profile> remove dsh-workbuddy-kit
npm uninstall -g dsh-workbuddy-kit                        # if installed globally
```

Nothing else is written outside the repository and `<stateDir>` (`~/.dsh-workbuddy` by default, override with `DWB_STATE_DIR`). Sessions the kit published into the app index can be removed one by one with `wb_unpublish_session` / `node bin/wb.mjs unpublish --session <id>`.

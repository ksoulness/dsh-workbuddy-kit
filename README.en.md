# DSH WorkBuddy Kit

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen.svg)](https://nodejs.org) [![MCP](https://img.shields.io/badge/MCP-stdio-8A2BE2.svg)](https://modelcontextprotocol.io) [![Release](https://img.shields.io/github/v/release/ksoulness/dsh-workbuddy-kit?display_name=tag)](https://github.com/ksoulness/dsh-workbuddy-kit/releases)

**English** · [中文](README.md)

> **DeepSeek Harness decides and verifies; the local Tencent WorkBuddy does the work.** Dispatch one bounded task, wait for a terminal state, check the evidence yourself, and the conversation shows up in the WorkBuddy desktop app under the same workspace.

A local kit that closes the loop between "DSH plans" and "WorkBuddy executes". Two front doors, one tool table:

- **Native DSH tool** (Cordis plugin `dsh-workbuddy-kit`, registers `wb_*` on `ctx.tools`)
- **stdio MCP server** (`dsh-workbuddy-mcp`, usable from any MCP client)

Both behave identically because they call the same `src/tools.mjs`.

## What problem it solves

| Without it | With it |
| --- | --- |
| To get WorkBuddy working you retype context, paths and acceptance criteria, then babysit the run | One dispatch returns a `runId`; `wait_run` blocks to a terminal state; `state` / `stopReason` / `toolCalls` / `workspaceChanges` are structured, and a timeout is not a terminal state |
| "It said it's done" counts as done? | Tools return **evidence**: git before/after comparison, tool-call counts, the full transcript, a sha256 archive copy — the caller still has to check |
| The dispatched conversation is invisible in the desktop app, so it may as well not have happened | Registered in the app index by default, under the **same workspace** (it follows the DSH working directory); clicking it opens the real conversation |
| Monitoring the desktop scheduler means opening tasks one by one | Three read-only tools over `workbuddy.db`: task list, per-run history, success rate and failure codes, overdue tasks |
| Its permission boundary is guesswork | A measured matrix in the docs: in-workspace read/write needs `acceptEdits`; cross-directory reads and `WebFetch`/`curl` need `bypassPermissions`; `WebSearch` is unavailable headless |

## What it drives

The WorkBuddy desktop app (Tencent, measured `5.8.3`) ships its own CodeBuddy agent CLI:

```text
D:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\
  bin\codebuddy                  # @genie/agent-cli entry (measured 2.161.0)
  dist\codebuddy-lite-wb.mjs     # current build only ships the lite-wb bundle
```

That CLI runs headless (`-p/--print`, `--output-format stream-json`, `--session-id`, `--permission-mode`, `--model`, `--max-turns`, `--effort`, …). This kit turns that channel into verifiable tools.

## In practice

```text
you  ❯ let WorkBuddy read PROJECT.md and quote its first section

DSH  ❯ wb_start_run { task: "...", maxTurns: 6 }      → runId, sessionId, pid, workspace
     ❯ wb_wait_run  { runId }                        → state:"succeeded", stopReason:"end_turn"
                                                       toolCalls:1, workspaceChanges, publishResult
     ❯ (open the transcript, compare the quote yourself)
     ❯ wb_archive_session { sessionId }               → archived:true, bytes, sha256
```

The session is now in the desktop app's sidebar, in the same workspace, with the whole exchange — including WorkBuddy's own tool calls.

## Install

### A. Native DSH tools (recommended)

```sh
git clone https://github.com/ksoulness/dsh-workbuddy-kit
cd dsh-workbuddy-kit
dsh plugin --profile <your-profile> add .
npm run verify        # 18/18 registration contract against the DSH you actually run
```

Then restart DSH — tools are snapshotted at boot, so adding or removing one needs a restart.

### B. MCP stdio

```json
{
  "mcpServers": {
    "workbuddy": {
      "command": "node",
      "args": ["E:/Code/dsh-workbuddy-kit/mcp/server.mjs"]
    }
  }
}
```

### C. Manual check, no client

```sh
node bin/wb.mjs doctor
node bin/wb.mjs run --task "read PROJECT.md and quote its first section" --wait 300
```

## Tools (18)

| Tool | What it does |
| --- | --- |
| `wb_doctor` | Read-only self-check: CLI, bundled Node, data directory, versions, custom models, recent auth walls |
| `wb_list_capabilities` | Real permission modes and custom model ids for a dispatch |
| `wb_list_projects` / `wb_list_sessions` | WorkBuddy project directories and the session transcripts on disk |
| `wb_start_run` | Dispatch an implementation task in a fresh session; `workspace` defaults to the DSH session directory |
| `wb_start_review` | Dispatch a read-only review (permission mode `plan`, `Write`/`Edit`/`NotebookEdit` denied) |
| `wb_wait_run` / `wb_get_run` | Wait for, or read, one run; `workspaceChanges` gives git-side evidence |
| `wb_cancel_run` | Cancel and terminate the whole child process tree |
| `wb_list_runs` | Recent dispatches recorded by this kit |
| `wb_read_session` | Read one transcript (messages, tool calls, model) |
| `wb_archive_session` | Digest-stamped copy of exactly one session transcript |
| `wb_list_automations` | Desktop scheduler tasks (status, soft-delete flag, schedule, next run, last outcome) |
| `wb_get_automation_runs` | Run history of one scheduled task, with failure codes |
| `wb_automation_health` | Scheduler health: live vs soft-deleted, success rate, failure codes, overdue tasks |
| `wb_publish_session` | Insert the desktop app's index row so a CLI session appears in its list (default on for dispatches) |
| `wb_unpublish_session` | Remove only the row this kit inserted; the transcript is never touched |
| `wb_list_published` | This kit's own publish ledger |

## Key constraints (all measured, not guessed)

1. The release only ships the `lite-wb` bundle → `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` is required.
2. The headless CLI cannot use the desktop login → the account-default model hits `Authentication required`; a custom model from `models.json` is used instead.
3. `state: succeeded` only means the process ended cleanly, so every run carries `workspaceChanges` (git porcelain before/after), tool-call counts and the transcript. Git-ignored paths are invisible to that check — read the file instead.
4. The desktop sidebar reads `workbuddy.db` (`transport='local'`, `deleted_at IS NULL`, `user_id` match). A CLI transcript without that row is **never** listed — that is why `wb_publish_session` exists, and why it is reversible.
5. Workspace grouping comes from the session's `cwd`, so dispatches follow the DSH session directory (verified by changing directories and re-dispatching). Publishing is the only vendor-state write in the whole kit: two rows, logged, undoable.
6. Scheduler access is read-only. Pausing or editing a scheduled task belongs to the app's own IPC/UI.

## Verified / not verified

- ✅ `node --test` 65/65: stream parsing, project-slug mapping, schema subset, MCP handshake, every archive refusal branch, read-only scheduler (soft delete, failure codes), git evidence, publish/unpublish/default-publish
- ✅ 18/18 tool registration contract against the real `dsh-tools` schemas (`npm run verify`)
- ✅ Real dispatches, both read-only and implementing, with the produced files checked by hand
- ✅ Sessions published into the desktop app index and confirmed in its sidebar
- ⚠️ Only the lite bundle was available to test; other WorkBuddy builds are untested
- ⚠️ Cross-directory reads and web fetching are blocked under `acceptEdits`; the workarounds above are the measured ones, not guarantees

## Layout

```text
bin/wb.mjs          CLI front door
plugin/index.mjs    Cordis plugin (native DSH tools)
mcp/server.mjs      stdio MCP front door
src/tools.mjs       the single tool table both front doors use
src/discover.mjs    install/data directory discovery, models, slug mapping
src/cli.mjs         command assembly, spawn, process-tree termination
src/parse.mjs       stream-json parsing, transcript reading (incl. function_call)
src/runs.mjs        run journal, terminal verdicts, reconcile, git evidence, default publish
src/sessions.mjs    list/read/archive sessions
src/automations.mjs read-only desktop scheduler
src/publish.mjs     the one write path into the app index
docs/               setup, architecture, security
skills/             the delegation skill for DSH
tests/              65 unit tests
```

## License

MIT. See [LICENSE](LICENSE).

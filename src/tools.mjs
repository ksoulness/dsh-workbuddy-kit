/**
 * The tool surface, defined once and mounted twice.
 *
 * The same table feeds the native DSH plugin (`ctx.tools.register`) and the
 * stdio MCP server, so a client can never see a tool whose behavior differs
 * between the two front doors.
 *
 * Schemas stay inside the Harness tool-schema subset
 * (type/oneOf/properties/required/additionalProperties/items/enum/const plus
 * the description/title/default/examples annotations).
 *
 * @module dsh-workbuddy-kit/src/tools
 */

import { automationHealth, getAutomationRuns, listAutomations } from './automations.mjs'
import { publishSession, readPublishedLedger, unpublishSession } from './publish.mjs'
import { PERMISSION_MODES } from './cli.mjs'
import { discover, resolveConfigDir } from './discover.mjs'
import { cancelRun, getRun, listAllRuns, startRun, waitRun, TERMINAL_STATES } from './runs.mjs'
import { archiveSession, listProjects, listSessions, readArchiveIndex, readSession } from './sessions.mjs'
import { resolveStateDir } from './store.mjs'

/** Output schema shared by every tool: a JSON object rendered as text. */
const OBJECT_OUTPUT = { type: 'object', properties: {}, additionalProperties: true }

/**
 * State directory for this call: an injected override first (tests, embedders),
 * then the documented default.
 * @param {{ env: NodeJS.ProcessEnv, stateDir?: string }} ctx
 * @returns {string}
 */
function stateDirOf(ctx) {
  return ctx.stateDir ?? resolveStateDir({ env: ctx.env })
}

/**
 * WorkBuddy data directory for this call.
 * @param {{ env: NodeJS.ProcessEnv, configDir?: string }} ctx
 * @returns {string}
 */
function configDirOf(ctx) {
  return ctx.configDir ?? resolveConfigDir({ env: ctx.env })
}

/**
 * Build one tool descriptor.
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters: object,
 *   handler: (args: any, ctx: { env: NodeJS.ProcessEnv }) => Promise<any> | any,
 * }} spec
 * @returns {object}
 */
function tool(spec) {
  return {
    ...spec,
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
  }
}

/**
 * Trim a run record to what a model should read.
 * @param {any} run
 * @param {{ full?: boolean }} [options]
 * @returns {any}
 */
export function summarizeRun(run, options = {}) {
  const base = {
    runId: run.runId,
    kind: run.kind,
    state: run.state,
    stateSource: run.stateSource ?? 'observation',
    terminal: TERMINAL_STATES.has(run.state),
    stopReason: run.stopReason ?? null,
    workspace: run.workspace,
    projectSlug: run.projectSlug,
    model: run.model ?? null,
    modelSource: run.modelSource ?? null,
    permissionMode: run.permissionMode,
    sessionId: run.sessionId ?? null,
    sessionFile: run.sessionFile ?? null,
    pid: run.pid ?? null,
    exitCode: run.exitCode ?? null,
    toolCalls: run.toolUseCount ?? 0,
    toolResults: run.toolResults ?? 0,
    durationMs: run.durationMs ?? null,
    usage: run.usage ?? null,
    costUsd: run.costUsd ?? null,
    createdAt: run.createdAt,
    terminalAt: run.terminalAt ?? null,
    journal: run.journal,
    final: run.journal ? String(run.journal).replace(/\.json$/, '.final.md') : null,
    hostMustCallWaitRunAgain: run.hostMustCallWaitRunAgain ?? !TERMINAL_STATES.has(run.state),
    ...(run.idempotentReplay ? { idempotentReplay: true } : {}),
    ...(run.note ? { note: run.note } : {}),
    ...(run.hint ? { hint: run.hint } : {}),
    ...(run.cancelSkipped ? { cancelSkipped: run.cancelSkipped } : {}),
    ...(run.termination ? { termination: run.termination } : {}),
    ...(run.publishToApp ? { publishToApp: true } : {}),
    ...(run.publishResult ? { publishResult: run.publishResult } : {}),
  }
  if (options.full) {
    base.assistantText = run.assistantText ?? ''
    base.diagnostics = (run.diagnostics ?? []).slice(0, 40)
    base.promptPreview = run.promptPreview ?? null
    base.authorizationBasis = run.authorizationBasis ?? null
    base.streamLog = run.streamLog ?? null
    base.workspaceChanges = boundGitEvidence(run.workspaceChanges)
  }
  return base
}

/**
 * Bound a git-status comparison to what a model should read.
 * @param {any} changes
 * @returns {any}
 */
function boundGitEvidence(changes) {
  if (!changes) return { available: false, reason: 'not recorded for this run' }
  if (!changes.available) return { available: false, reason: changes.reason ?? 'git status unavailable' }
  return {
    available: true,
    added: (changes.added ?? []).slice(0, 50),
    statusChanged: (changes.statusChanged ?? []).slice(0, 50),
    disappeared: (changes.disappeared ?? []).slice(0, 50),
    addedCount: (changes.added ?? []).length,
    changedCount: (changes.statusChanged ?? []).length,
    note: changes.note,
  }
}

/**
 * Authentication signal inferred from recent run diagnostics.
 * @param {any[]} runs
 * @returns {{ authenticated: boolean | null, evidence: string | null }}
 */
function authenticationSignal(runs) {
  for (const run of runs) {
    for (const line of run.diagnostics ?? []) {
      if (/Authentication required/i.test(line)) {
        return { authenticated: false, evidence: `run ${run.runId}: ${line}` }
      }
    }
  }
  return { authenticated: null, evidence: null }
}

/** Dispatcher, session, and archive tools (they run or inspect agent sessions). */
const sessionTools = [
  tool({
    name: 'wb_doctor',
    description:
      'Read-only self-check of the local WorkBuddy installation: CLI path, bundled Node runtime, data directory, app version, custom models, and whether recent runs hit an authentication wall. Starts no agent process.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const discovery = discover({ env: ctx.env })
      const stateDir = stateDirOf(ctx)
      const runs = listAllRuns({ stateDir, limit: 20, env: ctx.env })
      return {
        found: discovery.found,
        reasons: discovery.reasons,
        installRoot: discovery.installRoot,
        cliDir: discovery.cliDir,
        cliEntry: discovery.cliEntry,
        nodeBinary: discovery.nodeBinary,
        appVersion: discovery.appVersion,
        liteBundleOnly: discovery.liteBundleOnly,
        configDir: discovery.configDir,
        projectsDir: discovery.projectsDir,
        customModels: discovery.customModels,
        stateDir,
        archiveIndexEntries: readArchiveIndex(stateDir).length,
        recentRuns: runs.length,
        authentication: authenticationSignal(runs),
        permissionModes: PERMISSION_MODES,
      }
    },
  }),

  tool({
    name: 'wb_list_capabilities',
    description:
      'List the real choices for a WorkBuddy dispatch: permission modes, custom models configured in the WorkBuddy data directory, and the tools the last run reported loading. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const discovery = discover({ env: ctx.env })
      const runs = listAllRuns({ stateDir: stateDirOf(ctx), limit: 50, env: ctx.env })
      const lastWithTools = runs.find((run) => typeof run.availableToolCount === 'number')
      return {
        permissionModes: PERMISSION_MODES,
        customModels: discovery.customModels,
        note: 'Pass a custom model id verbatim (for example "custom-local:cn:deepseek-v4.1-flash"); omit model to use the account default.',
        lastRunToolCount: lastWithTools?.availableToolCount ?? null,
        observedModels: [...new Set(runs.map((run) => run.model).filter((value) => typeof value === 'string'))],
      }
    },
  }),

  tool({
    name: 'wb_list_projects',
    description: 'List the WorkBuddy project directories under the data directory, with session counts and last activity. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const configDir = configDirOf(ctx)
      return { configDir, projects: listProjects({ configDir }).slice(0, 50) }
    },
  }),

  tool({
    name: 'wb_start_run',
    description:
      'Dispatch an implementation-style task to WorkBuddy in a fresh agent session inside the given workspace. Returns a runId immediately; call wb_wait_run until the run is terminal, then read the evidence yourself. The task text is a delegation, so state scope, allowed paths, and acceptance criteria in it — do not paste source code.',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description:
            'Absolute workspace directory the agent may work in. Defaults to the current DSH working directory, which keeps the session inside the same workspace the desktop app already groups it under.',
        },
        task: { type: 'string', description: 'What WorkBuddy must do, including scope and acceptance criteria.' },
        model: { type: 'string', description: 'Optional model id; omit to use the WorkBuddy account default.' },
        permissionMode: {
          type: 'string',
          enum: PERMISSION_MODES,
          description: 'CLI permission mode; defaults to acceptEdits for wb_start_run.',
        },
        maxTurns: { type: 'integer', description: 'Optional cap on agentic turns.' },
        effort: { type: 'string', description: 'Optional reasoning effort (minimal, low, medium, high, xhigh, max).' },
        skipPermissions: {
          type: 'boolean',
          description:
            'Pass the CLI -y flag. Vendor docs make it required for headless tool use; HIGH/CRITICAL commands may still ask. Opt-in only.',
        },
        idempotencyKey: { type: 'string', description: 'Reuse the same key to get the same runId instead of a duplicate dispatch.' },
        sessionId: { type: 'string', description: 'Optional explicit session id; omit to let WorkBuddy create a fresh one.' },
        addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories the agent may read.' },
        publishToApp: {
          type: 'boolean',
          description:
            'After the run finishes, also insert its index row so the conversation shows up in the desktop WorkBuddy app (same workspace as the dispatch target). Defaults to false; undone by wb_unpublish_session.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const run = await startRun(
        {
          kind: 'run',
          workspace: args.workspace ?? ctx.cwd ?? process.cwd(),
          prompt: args.task,
          model: args.model,
          permissionMode: args.permissionMode,
          maxTurns: args.maxTurns,
          effort: args.effort,
          skipPermissions: args.skipPermissions,
          idempotencyKey: args.idempotencyKey,
          sessionId: args.sessionId,
          addDirs: args.addDirs,
          publishToApp: args.publishToApp === true,
        },
        { env: ctx.env, stateDir: ctx.stateDir },
      )
      return { ...summarizeRun(run), waitHint: run.waitHint ?? null }
    },
  }),

  tool({
    name: 'wb_start_review',
    description:
      'Dispatch a read-only review to WorkBuddy: permission mode plan, with Write/Edit/NotebookEdit denied. Use it for "check this, do not change anything" work. Returns a runId; call wb_wait_run until terminal.',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Absolute workspace directory to review. Defaults to the current DSH working directory.',
        },
        task: { type: 'string', description: 'What to review and what evidence to return (file paths, line numbers, conclusions).' },
        model: { type: 'string', description: 'Optional model id.' },
        maxTurns: { type: 'integer', description: 'Optional cap on agentic turns.' },
        idempotencyKey: { type: 'string', description: 'Reuse the same key to get the same runId.' },
        addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories the agent may read.' },
        publishToApp: {
          type: 'boolean',
          description:
            'After the run finishes, also insert its index row so the conversation shows up in the desktop WorkBuddy app (same workspace as the dispatch target). Defaults to false; undone by wb_unpublish_session.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const run = await startRun(
        {
          kind: 'review',
          workspace: args.workspace ?? ctx.cwd ?? process.cwd(),
          prompt: args.task,
          model: args.model,
          maxTurns: args.maxTurns,
          idempotencyKey: args.idempotencyKey,
          addDirs: args.addDirs,
          publishToApp: args.publishToApp === true,
        },
        { env: ctx.env, stateDir: ctx.stateDir },
      )
      return { ...summarizeRun(run), waitHint: run.waitHint ?? null }
    },
  }),

  tool({
    name: 'wb_wait_run',
    description:
      'Block until a run reaches a terminal state or the timeout expires. A timeout is not a terminal state: when hostMustCallWaitRunAgain is true, call this again with the same runId.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id returned by a dispatch tool.' },
        timeoutMs: { type: 'integer', description: 'Maximum wait in milliseconds (default 120000).' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const run = await waitRun({ runId: args.runId, timeoutMs: args.timeoutMs }, { env: ctx.env, stateDir: ctx.stateDir })
      return summarizeRun(run, { full: true })
    },
  }),

  tool({
    name: 'wb_get_run',
    description: 'Read the current recorded state of one run without waiting. Prefer wb_wait_run for anything still running.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run id.' } },
      required: ['runId'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => summarizeRun(getRun(args.runId, { env: ctx.env, stateDir: ctx.stateDir }), { full: true }),
  }),

  tool({
    name: 'wb_cancel_run',
    description: 'Cancel a run and terminate its whole child process tree. A run that is already terminal is returned unchanged.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id.' },
        graceMs: { type: 'integer', description: 'Milliseconds to wait for a graceful stop before force-killing.' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => summarizeRun(await cancelRun(args.runId, { env: ctx.env, graceMs: args.graceMs }), { full: true }),
  }),

  tool({
    name: 'wb_list_runs',
    description: 'List recent dispatches recorded by this kit, newest first. Read-only.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Maximum runs to return (default 20).' } },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const limit = args.limit ?? 20
      const runs = listAllRuns({ stateDir: stateDirOf(ctx), limit, env: ctx.env })
      return { runs: runs.map((run) => summarizeRun(run)) }
    },
  }),

  tool({
    name: 'wb_list_sessions',
    description:
      'List WorkBuddy session transcripts on disk (the vendor session store the desktop app also shows), newest first. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Only list sessions for this workspace directory.' },
        project: { type: 'string', description: 'Only list sessions for this WorkBuddy project directory name.' },
        limit: { type: 'integer', description: 'Maximum sessions to return (default 20).' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const configDir = configDirOf(ctx)
      const sessions = listSessions({
        configDir,
        project: args.project,
        cwd: args.workspace,
        limit: args.limit ?? 20,
      })
      return { configDir, sessions }
    },
  }),

  tool({
    name: 'wb_read_session',
    description:
      'Read one session transcript (messages, tool calls, model) for a given session id so you can verify the work yourself instead of trusting a summary.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Exact session id.' },
        project: { type: 'string', description: 'Optional WorkBuddy project directory name to disambiguate.' },
        limit: { type: 'integer', description: 'Maximum transcript entries to return (default 200).' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const configDir = configDirOf(ctx)
      const transcript = readSession({ configDir, sessionId: args.sessionId, project: args.project })
      const limit = args.limit ?? 200
      return {
        ...transcript,
        entries: transcript.entries.slice(-limit),
        entriesReturned: Math.min(limit, transcript.entries.length),
      }
    },
  }),

  tool({
    name: 'wb_archive_session',
    description:
      'Archive exactly one session transcript: a digest-stamped copy under <configDir>/session-archive/<date>/<project>/ plus an index entry. Refuses live or non-terminal sessions instead of guessing. WorkBuddy\'s own session list is not modified unless mode is "move".',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Exact session id to archive.' },
        project: { type: 'string', description: 'Optional project directory name to disambiguate.' },
        mode: { type: 'string', enum: ['copy', 'move'], description: 'copy (default, non-destructive) or move.' },
        force: { type: 'boolean', description: 'Archive even if the transcript was written moments ago.' },
        requireTerminal: { type: 'boolean', description: 'Refuse sessions with no completion record (default true).' },
        overwrite: { type: 'boolean', description: 'Replace an existing archive copy.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const configDir = configDirOf(ctx)
      const stateDir = stateDirOf(ctx)
      const recentRuns = listAllRuns({ stateDir, limit: 200, env: ctx.env })
      const activeSessionIds = recentRuns
        .filter((run) => !TERMINAL_STATES.has(run.state))
        .map((run) => run.sessionId)
        .filter((value) => typeof value === 'string')
      const completedSessionIds = recentRuns
        .filter((run) => TERMINAL_STATES.has(run.state))
        .map((run) => run.sessionId)
        .filter((value) => typeof value === 'string')
      const result = archiveSession({
        configDir,
        stateDir,
        sessionId: args.sessionId,
        project: args.project,
        mode: args.mode,
        force: args.force,
        requireTerminal: args.requireTerminal,
        overwrite: args.overwrite,
        activeSessionIds,
        completedSessionIds,
      })
      return result
    },
  }),
]

/**
 * Desktop-scheduler tools: they read the WorkBuddy app's own SQLite scheduler
 * (`automations` / `automation_runs` / `automation_runtime_state`) read-only.
 * Nothing here dispatches an agent or writes scheduler state.
 */
const schedulerTools = [
  tool({
    name: 'wb_list_automations',
    description:
      'List the desktop WorkBuddy scheduler: scheduled tasks with status, soft-delete flag, schedule (RRULE), next run, last run outcome, model, permission mode, workspace and push channels. Reads workbuddy.db read-only; task prompts are excluded unless includePrompt is true.',
    parameters: {
      type: 'object',
      properties: {
        includeDeleted: { type: 'boolean', description: 'Include soft-deleted rows (deleted_at set, status may still read ACTIVE).' },
        includePrompt: { type: 'boolean', description: 'Include a bounded prompt preview per task (default false).' },
        limit: { type: 'integer', description: 'Maximum tasks to return (default 50, max 200).' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) =>
      listAutomations({
        env: ctx.env,
        configDir: ctx.configDir,
        includeDeleted: args.includeDeleted === true,
        includePrompt: args.includePrompt === true,
        limit: args.limit,
      }),
  }),

  tool({
    name: 'wb_get_automation_runs',
    description:
      'Read the run history of one scheduled task (by exact id or name substring): status, timestamp, success flag, failure code, and per-task totals with failure-code counts. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        automationId: { type: 'string', description: 'Exact automation id.' },
        name: { type: 'string', description: 'Name substring, used when automationId is omitted.' },
        limit: { type: 'integer', description: 'Maximum runs to return (default 20, max 200).' },
        failuresOnly: { type: 'boolean', description: 'Only return runs with result_success = 0.' },
        includeTitle: { type: 'boolean', description: 'Include a bounded thread-title preview (default true).' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) =>
      getAutomationRuns({
        env: ctx.env,
        configDir: ctx.configDir,
        automationId: args.automationId,
        name: args.name,
        limit: args.limit,
        failuresOnly: args.failuresOnly === true,
        includeTitle: args.includeTitle !== false,
      }),
  }),

  tool({
    name: 'wb_automation_health',
    description:
      'Scheduler-level health: live vs soft-deleted tasks, total/succeeded/failed runs with a success rate, failure-code breakdown, per-task run counts, and tasks whose next_run_at is already overdue. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Maximum tasks in the per-task breakdown (default 20).' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) =>
      automationHealth({ env: ctx.env, configDir: ctx.configDir, limit: args.limit }),
  }),
]

/**
 * Publishing tools: they insert (and remove) the desktop app's index row for a
 * CLI session so the conversation shows up in the app's own list. This is the
 * only write path into vendor state in the whole kit.
 */
const publishTools = [
  tool({
    name: 'wb_publish_session',
    description:
      'Make one CLI-dispatched session visible in the desktop WorkBuddy app by inserting its missing index row into workbuddy.db (sessions + session_usage). Writes vendor state, so it is explicit, single-session, refuses anything it cannot verify, and is undone by wb_unpublish_session. The transcript file is never modified.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Exact session id (the CLI session you want the app to list).' },
        runId: { type: 'string', description: 'Alternatively, the runId from a dispatch; its sessionId is resolved for you.' },
        project: { type: 'string', description: 'Optional WorkBuddy project directory name to disambiguate.' },
        title: { type: 'string', description: 'Optional title override; defaults to the dispatched task summary.' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args, ctx) =>
      publishSession({
        configDir: configDirOf(ctx),
        stateDir: stateDirOf(ctx),
        sessionId: args.sessionId,
        runId: args.runId,
        project: args.project,
        title: args.title,
      }),
  }),

  tool({
    name: 'wb_unpublish_session',
    description:
      'Remove the index row this kit inserted for a session. Deletes only the sessions/session_usage rows and only when the publish ledger shows this kit created them (unless force). The transcript stays on disk.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Exact session id.' },
        force: { type: 'boolean', description: 'Delete the row even if this kit has no publish record for it.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    handler: async (args, ctx) =>
      unpublishSession({
        configDir: configDirOf(ctx),
        stateDir: stateDirOf(ctx),
        sessionId: args.sessionId,
        force: args.force === true,
      }),
  }),

  tool({
    name: 'wb_list_published',
    description: 'List the sessions this kit has published into the desktop app index (its own ledger, read-only).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const stateDir = stateDirOf(ctx)
      const entries = readPublishedLedger(stateDir)
      return {
        stateDir,
        published: entries.filter((entry) => entry.unpublished !== true),
        unpublished: entries.filter((entry) => entry.unpublished === true),
        note: 'This is the kit ledger, not the app database; the app side is readable through wb_list_automations-style queries.',
      }
    },
  }),
]

/** Every tool this kit exposes. */
export const tools = [...sessionTools, ...schedulerTools, ...publishTools]

/**
 * Look up one tool by name.
 * @param {string} name
 * @returns {object | undefined}
 */
export function findTool(name) {
  return tools.find((entry) => entry.name === name)
}

/**
 * Names of every exposed tool.
 * @returns {string[]}
 */
export function toolNames() {
  return tools.map((entry) => entry.name)
}

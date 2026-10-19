/**
 * Dispatch, monitor, and terminate delegated WorkBuddy runs.
 *
 * One dispatch owns one fresh CLI process and one run id. The journal is the
 * only source of truth for state: it is written before the child starts, on
 * every meaningful event, and on exit. `wait_run` never invents a terminal
 * state — it either observes one or reports that the caller must wait again.
 *
 * @module dsh-workbuddy-kit/src/runs
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildInvocation, isProcessAlive, runInvocation, terminateTree, WRITE_TOOLS } from './cli.mjs'
import { discover, projectSlug } from './discover.mjs'
import { flattenContent, summarizeSessionFile } from './parse.mjs'
import { ensureStateDir, loadRun, listRuns, openSink, resolveStateDir, runPaths, saveRun, writeJsonAtomic } from './store.mjs'

/** Terminal run states. */
export const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'unknown'])

/** Assistant text kept inside the journal (the full text is also on disk). */
const JOURNAL_TEXT_LIMIT = 20_000

/** Cap for re-reading a raw stream log during recovery. */
const STREAM_READ_LIMIT = 32 * 1024 * 1024

/**
 * Deterministic run id from an idempotency key, or a timestamped random one.
 * @param {string | undefined} idempotencyKey
 * @param {() => number} [now]
 * @returns {string}
 */
export function makeRunId(idempotencyKey, now = Date.now) {
  if (typeof idempotencyKey === 'string' && idempotencyKey.trim() !== '') {
    const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16)
    return `wb-${digest}`
  }
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
  const salt = Math.random().toString(36).slice(2, 8)
  return `wb-${stamp}-${salt}`
}

/**
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
function boundText(text, limit = JOURNAL_TEXT_LIMIT) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`
}

/**
 * Read a UTF-8 file, keeping only the tail when it exceeds the cap.
 * @param {string} file
 * @param {number} [limit]
 * @returns {string}
 */
function readTextBounded(file, limit = STREAM_READ_LIMIT) {
  const stat = statSync(file)
  if (stat.size <= limit) return readFileSync(file, 'utf8')
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    readSync(fd, buffer, 0, limit, stat.size - limit)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * Resolve the pieces every run needs.
 * @param {{ discovery?: any, stateDir?: string, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {{ discovery: any, stateDir: string }}
 */
function resolveContext(deps = {}) {
  const discovery = deps.discovery ?? discover({ env: deps.env })
  const stateDir = deps.stateDir ?? resolveStateDir({ env: deps.env })
  return { discovery, stateDir }
}

/**
 * Recover the verdict for a run whose process is gone.
 *
 * This is the one place state is inferred instead of observed, and it records
 * `stateSource: 'transcript' | 'process-exit'` so a caller can tell a live
 * observation from a recovered one.
 *
 * @param {any} run
 * @param {{ configDir: string }} discovery
 * @returns {any}
 */
export function reconcileRun(run, discovery) {
  if (TERMINAL_STATES.has(run.state)) return run
  if (isProcessAlive(run.pid)) return run
  const sessionFile =
    run.sessionFile ??
    (run.sessionId ? join(discovery.configDir, 'projects', run.projectSlug ?? '', `${run.sessionId}.jsonl`) : null)
  if (sessionFile && existsSync(sessionFile)) {
    try {
      const summary = summarizeSessionFile(sessionFile)
      if (summary.hasResult) {
        return {
          ...run,
          state: 'succeeded',
          stopReason: 'recovered-from-transcript',
          stateSource: 'transcript',
          assistantText: run.assistantText || boundText(summary.lastAssistantText),
          sessionId: run.sessionId ?? summary.sessionId,
          terminalAt: new Date().toISOString(),
        }
      }
    } catch {
      /* fall through to the process-exit verdict */
    }
  }
  const updatedAtMs = Date.parse(run.updatedAt ?? run.createdAt ?? '')
  const idleSeconds = Number.isFinite(updatedAtMs) ? Math.round((Date.now() - updatedAtMs) / 1000) : null
  return {
    ...run,
    state: 'unknown',
    stopReason: 'process-exited-without-result',
    stateSource: 'process-exit',
    terminalAt: new Date().toISOString(),
    note: idleSeconds === null ? 'no result event observed' : `no result event observed; journal idle ${idleSeconds}s`,
  }
}

/**
 * Start one delegated run.
 * @param {{
 *   kind?: 'review' | 'run',
 *   workspace: string,
 *   prompt: string,
 *   model?: string,
 *   permissionMode?: string,
 *   maxTurns?: number,
 *   effort?: string,
 *   skipPermissions?: boolean,
 *   sessionId?: string,
 *   idempotencyKey?: string,
 *   authorizationBasis?: string,
 *   addDirs?: string[],
 *   allowedTools?: string[],
 *   disallowedTools?: string[],
 *   env?: NodeJS.ProcessEnv,
 * }} input
 * @param {{ discovery?: any, stateDir?: string, initWaitMs?: number }} [deps]
 * @returns {Promise<any>} the run journal once the child reports its session
 */
export async function startRun(input, deps = {}) {
  const { discovery, stateDir } = resolveContext(deps)
  if (!discovery.found) throw new Error(`WorkBuddy is not usable: ${discovery.reasons.join('; ')}`)
  const workspace = input.workspace?.trim()
  if (!workspace) throw new Error('workspace is required')
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`workspace is not an existing directory: ${workspace}`)
  }
  const kind = input.kind ?? 'run'
  const reviewMode = kind === 'review'
  const permissionMode = input.permissionMode ?? (reviewMode ? 'plan' : 'acceptEdits')
  const disallowedTools = reviewMode
    ? [...new Set([...(input.disallowedTools ?? []), ...WRITE_TOOLS])]
    : input.disallowedTools

  const runId = makeRunId(input.idempotencyKey)
  ensureStateDir(stateDir)
  const previous = loadRun(stateDir, runId)
  if (previous && previous.state !== 'cancelled') return { ...previous, idempotentReplay: true }

  const paths = runPaths(stateDir, runId)
  // The headless CLI cannot reuse the desktop app's account session, so an
  // unqualified "auto" model fails with "Authentication required". When the
  // user has custom models configured, default to the first one and record
  // where that default came from.
  const requestedModel = input.model ?? discovery.defaultModel ?? undefined
  const modelSource = input.model ? 'explicit' : discovery.defaultModel ? discovery.defaultModelSource : 'account-default'
  const run = {
    runId,
    kind,
    state: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspace,
    projectSlug: projectSlug(workspace),
    promptSha256: createHash('sha256').update(input.prompt).digest('hex'),
    promptBytes: Buffer.byteLength(input.prompt, 'utf8'),
    promptPreview: boundText(input.prompt, 4000),
    model: requestedModel ?? null,
    modelSource,
    permissionMode,
    maxTurns: input.maxTurns ?? null,
    effort: input.effort ?? null,
    sessionId: input.sessionId ?? null,
    sessionFile: null,
    pid: null,
    exitCode: null,
    signal: null,
    stopReason: null,
    stateSource: 'observation',
    authorizationBasis: input.authorizationBasis ?? 'explicit-user-request',
    idempotencyKey: input.idempotencyKey ?? null,
    cliVersion: discovery.appVersion ?? null,
    assistantText: '',
    toolUseCount: 0,
    toolResults: 0,
    diagnostics: [],
    usage: null,
    costUsd: null,
    durationMs: null,
    eventCount: 0,
    parseErrors: 0,
    journal: paths.journal,
    streamLog: paths.stream,
    stderrLog: paths.stderr,
  }
  saveRun(stateDir, run)

  const invocation = buildInvocation({
    discovery,
    prompt: input.prompt,
    workspace,
    model: requestedModel,
    permissionMode,
    sessionId: input.sessionId,
    maxTurns: input.maxTurns,
    effort: input.effort,
    skipPermissions: input.skipPermissions === true,
    addDirs: input.addDirs,
    allowedTools: input.allowedTools,
    disallowedTools,
    env: input.env,
  })

  const streamSink = openSink(paths.stream)
  const stderrSink = openSink(paths.stderr)
  const finished = runInvocation({
    invocation,
    onStart: (child) => {
      run.pid = child.pid ?? null
      run.state = 'running'
      run.startedAt = new Date().toISOString()
      saveRun(stateDir, run)
    },
    onRaw: (line) => streamSink.write(`${line}\n`),
    onStderr: (chunk) => {
      stderrSink.write(chunk)
      if (run.diagnostics.length < 200) {
        for (const line of String(chunk).split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed !== '') run.diagnostics.push(trimmed)
        }
      }
    },
    onEvent: (event) => {
      if (event.type === 'system' && event.subtype === 'init') {
        if (typeof event.session_id === 'string') {
          run.sessionId = event.session_id
          run.sessionFile = join(discovery.configDir, 'projects', run.projectSlug, `${event.session_id}.jsonl`)
        }
        if (typeof event.model === 'string') run.model = event.model
        if (Array.isArray(event.tools)) run.availableToolCount = event.tools.length
        saveRun(stateDir, run)
        return
      }
      if (event.type === 'assistant') {
        const flat = flattenContent(event.message?.content ?? event.content)
        if (flat.text !== '') {
          run.assistantText = run.assistantText === '' ? flat.text : `${run.assistantText}\n\n${flat.text}`
        }
        run.toolUseCount += flat.toolUses.length
        return
      }
      if (event.type === 'user') {
        const flat = flattenContent(event.message?.content ?? event.content)
        run.toolResults += flat.toolResults
      }
    },
  })

  const initWaitMs = deps.initWaitMs ?? 8000
  const deadline = Date.now() + initWaitMs
  let settled = false
  finished.then(() => {
    settled = true
  })
  while (run.sessionId === null && !settled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  finished
    .then(({ exitCode, signal }) => finalizeRun({ stateDir, discovery, runId, exitCode, signal }))
    .catch((error) => {
      const failed = loadRun(stateDir, runId) ?? run
      saveRun(stateDir, {
        ...failed,
        state: 'failed',
        stopReason: 'spawn-error',
        diagnostics: [...failed.diagnostics, String(error?.message ?? error)].slice(0, 200),
        terminalAt: new Date().toISOString(),
      })
    })
    .finally(() => {
      streamSink.close()
      stderrSink.close()
    })

  const current = loadRun(stateDir, runId) ?? run
  return {
    ...current,
    assistantText: boundText(current.assistantText),
    waitHint: TERMINAL_STATES.has(current.state) ? null : 'call wait_run with this runId',
  }
}

/**
 * Write the terminal verdict for a run that just exited.
 * @param {{ stateDir: string, discovery: any, runId: string, exitCode: number | null, signal: string | null }} input
 * @returns {any}
 */
export function finalizeRun(input) {
  const { stateDir, discovery, runId, exitCode, signal } = input
  const run = loadRun(stateDir, runId)
  if (!run) return undefined
  if (TERMINAL_STATES.has(run.state) && run.state !== 'unknown') return run
  const snapshot = summarizeJournalStream(runPaths(stateDir, runId).stream)
  const updated = {
    ...run,
    exitCode,
    signal,
    assistantText: boundText(snapshot.assistantText) || run.assistantText,
    toolUseCount: snapshot.toolUseCount || run.toolUseCount,
    toolResults: snapshot.toolResults || run.toolResults,
    usage: snapshot.usage ?? run.usage,
    costUsd: snapshot.costUsd ?? run.costUsd,
    durationMs: snapshot.durationMs ?? run.durationMs,
    eventCount: snapshot.eventCount,
    parseErrors: snapshot.parseErrors,
    model: snapshot.model ?? run.model,
    diagnostics: [...run.diagnostics, ...snapshot.diagnostics].slice(0, 200),
    sessionId: snapshot.sessionId ?? run.sessionId,
  }
  if (updated.sessionId && !updated.sessionFile) {
    updated.sessionFile = join(discovery.configDir, 'projects', run.projectSlug, `${updated.sessionId}.jsonl`)
  }
  const authenticationFailure = /Authentication required/i.test(updated.assistantText ?? '')
  if (authenticationFailure) {
    updated.state = 'failed'
    updated.stopReason = 'authentication-required'
    updated.stateSource = 'observation'
    updated.hint =
      'The headless CLI has no access to the desktop app\'s signed-in account, so the account-default model cannot start. Pass a custom model id (see wb_list_capabilities) or set DWB_DEFAULT_MODEL.'
  } else if (snapshot.result) {
    updated.state = snapshot.result.isError ? 'failed' : 'succeeded'
    updated.stopReason = snapshot.result.isError ? snapshot.result.subtype || 'error' : 'end_turn'
    updated.stateSource = 'observation'
  } else if ((exitCode !== null && exitCode !== 0) || signal) {
    updated.state = 'failed'
    updated.stopReason = `process-exit-${exitCode ?? signal}`
    updated.stateSource = 'process-exit'
  } else {
    updated.state = 'unknown'
    updated.stopReason = 'no-result-event'
    updated.stateSource = 'process-exit'
  }
  updated.terminalAt = new Date().toISOString()
  saveRun(stateDir, updated)
  try {
    const body = [
      `# ${runId}`,
      '',
      `- state: ${updated.state}`,
      `- stopReason: ${updated.stopReason}`,
      `- stateSource: ${updated.stateSource}`,
      `- model: ${updated.model ?? 'unknown'}`,
      `- sessionId: ${updated.sessionId ?? 'unknown'}`,
      `- workspace: ${updated.workspace}`,
      `- permissionMode: ${updated.permissionMode}`,
      `- toolCalls: ${updated.toolUseCount}`,
      '',
      '## assistant text',
      '',
      updated.assistantText || '(none)',
      '',
      '## diagnostics',
      '',
      ...(updated.diagnostics.length > 0 ? updated.diagnostics.map((line) => `- ${line}`) : ['(none)']),
      '',
    ].join('\n')
    writeFileSync(runPaths(stateDir, runId).final, body, 'utf8')
  } catch {
    /* the journal is authoritative; the markdown copy is a convenience */
  }
  return updated
}

/**
 * Re-read the raw stream log to recover detail a crashed host never journaled.
 * @param {string} streamFile
 * @returns {{ assistantText: string, toolUseCount: number, toolResults: number, usage: any, costUsd: number | null, durationMs: number | null, eventCount: number, parseErrors: number, model: string | null, sessionId: string | null, diagnostics: string[], result: any }}
 */
export function summarizeJournalStream(streamFile) {
  const summary = {
    assistantText: '',
    toolUseCount: 0,
    toolResults: 0,
    usage: null,
    costUsd: null,
    durationMs: null,
    eventCount: 0,
    parseErrors: 0,
    model: null,
    sessionId: null,
    diagnostics: [],
    result: null,
  }
  if (!existsSync(streamFile)) return summary
  let text = ''
  try {
    text = readTextBounded(streamFile)
  } catch {
    return summary
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      summary.parseErrors += 1
      continue
    }
    summary.eventCount += 1
    if (typeof event.session_id === 'string' && summary.sessionId === null) summary.sessionId = event.session_id
    if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') summary.model = event.model
    if (event.type === 'assistant') {
      const flat = flattenContent(event.message?.content ?? event.content)
      summary.toolUseCount += flat.toolUses.length
      if (flat.text !== '') {
        summary.assistantText = summary.assistantText === '' ? flat.text : `${summary.assistantText}\n\n${flat.text}`
      }
    }
    if (event.type === 'user') {
      summary.toolResults += flattenContent(event.message?.content ?? event.content).toolResults
    }
    if (event.type === 'result') {
      summary.result = {
        subtype: event.subtype ?? 'unknown',
        isError: event.is_error === true,
        text: typeof event.result === 'string' ? event.result : '',
      }
      summary.usage = event.usage ?? null
      summary.costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null
      summary.durationMs = typeof event.duration_ms === 'number' ? event.duration_ms : null
      if (typeof event.session_id === 'string') summary.sessionId = event.session_id
    }
  }
  return summary
}

/**
 * Read one run, reconciling a stale journal on the way.
 * @param {string} runId
 * @param {{ stateDir?: string, discovery?: any, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {any}
 */
export function getRun(runId, deps = {}) {
  const { discovery, stateDir } = resolveContext(deps)
  const run = loadRun(stateDir, runId)
  if (!run) throw new Error(`unknown runId: ${runId}`)
  const reconciled = reconcileRun(run, discovery)
  if (reconciled !== run) saveRun(stateDir, reconciled)
  return { ...reconciled, assistantText: boundText(reconciled.assistantText) }
}

/**
 * Poll a run until it reaches a terminal state or the deadline expires.
 * @param {{ runId: string, timeoutMs?: number, pollMs?: number }} input
 * @param {{ stateDir?: string, discovery?: any, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {Promise<any>}
 */
export async function waitRun(input, deps = {}) {
  const timeoutMs = input.timeoutMs ?? 120_000
  const pollMs = input.pollMs ?? 500
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let run = getRun(input.runId, deps)
  while (!TERMINAL_STATES.has(run.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    run = getRun(input.runId, deps)
  }
  return {
    ...run,
    hostMustCallWaitRunAgain: !TERMINAL_STATES.has(run.state),
    waitedMs: Date.now() - startedAt,
  }
}

/**
 * Cancel a run and its child tree.
 * @param {string} runId
 * @param {{ stateDir?: string, discovery?: any, env?: NodeJS.ProcessEnv, graceMs?: number }} [deps]
 * @returns {Promise<any>}
 */
export async function cancelRun(runId, deps = {}) {
  const { stateDir } = resolveContext(deps)
  const run = loadRun(stateDir, runId)
  if (!run) throw new Error(`unknown runId: ${runId}`)
  if (TERMINAL_STATES.has(run.state)) return { ...run, cancelSkipped: 'already-terminal' }
  const termination = run.pid
    ? await terminateTree(run.pid, { graceMs: deps.graceMs })
    : { signalled: false, method: 'no-pid' }
  const updated = {
    ...run,
    state: 'cancelled',
    stopReason: 'cancelled-by-host',
    stateSource: 'observation',
    termination,
    terminalAt: new Date().toISOString(),
  }
  saveRun(stateDir, updated)
  return updated
}

/**
 * Recent runs, newest first.
 * @param {{ stateDir?: string, limit?: number, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {any[]}
 */
export function listAllRuns(deps = {}) {
  const stateDir = deps.stateDir ?? resolveStateDir({ env: deps.env })
  return listRuns(stateDir, { limit: deps.limit })
}

/**
 * Create a directory when missing.
 * @param {string} dir
 * @returns {string}
 */
export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export { readTextBounded, writeJsonAtomic }

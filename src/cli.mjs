/**
 * Spawn and decode one headless WorkBuddy (CodeBuddy) agent run.
 *
 * The bundled CLI exposes exactly what a delegating host needs:
 *   `-p/--print`, `--output-format stream-json`, `--session-id <uuid>`,
 *   `--permission-mode`, `--model`, `--add-dir`, `--max-turns`, `--effort`.
 * This module builds that invocation and turns its JSONL stream into one
 * structured record; it never interprets model text as instructions.
 *
 * @module dsh-workbuddy-kit/src/cli
 */

import { spawn } from 'node:child_process'
import { createParser } from './parse.mjs'

/** Permission modes accepted by the bundled CLI. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']

/** Tools that mutate the workspace, denied for read-only dispatches. */
export const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']

/** UUID-ish session id guard (the CLI accepts letters, digits, `-`, `_`, `:`). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * Build the child process description for one dispatch.
 * @param {{
 *   discovery: { cliEntry: string, nodeBinary: string, configDir: string, liteBundleOnly: boolean },
 *   prompt: string,
 *   workspace: string,
 *   model?: string,
 *   permissionMode?: string,
 *   sessionId?: string,
 *   maxTurns?: number,
 *   effort?: string,
 *   addDirs?: string[],
 *   allowedTools?: string[],
 *   disallowedTools?: string[],
 *   appendSystemPrompt?: string,
 *   skipPermissions?: boolean,
 *   extraArgs?: string[],
 *   env?: NodeJS.ProcessEnv,
 * }} options
 * @returns {{ command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string }}
 */
export function buildInvocation(options) {
  const { discovery, prompt, workspace } = options
  if (!discovery?.cliEntry) throw new Error('WorkBuddy CLI entry is unknown; run doctor first')
  if (!discovery?.nodeBinary) throw new Error('no Node.js runtime found for the WorkBuddy CLI')
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('prompt must be a non-empty string')
  const permissionMode = options.permissionMode ?? 'default'
  if (!PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`permissionMode must be one of ${PERMISSION_MODES.join(', ')}`)
  }
  const sessionId = options.sessionId
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('sessionId must start with a letter or digit and contain only letters, digits, ".", "_", "-" or ":"')
  }
  const args = ['-p', '--output-format', 'stream-json', '--permission-mode', permissionMode]
  if (sessionId) args.push('--session-id', sessionId)
  if (options.model) args.push('--model', options.model)
  if (Number.isInteger(options.maxTurns) && options.maxTurns > 0) args.push('--max-turns', String(options.maxTurns))
  if (options.effort) args.push('--effort', options.effort)
  // Vendor docs: -y is required for non-interactive tool use; HIGH/CRITICAL
  // commands may still ask. It is opt-in here, never implied.
  if (options.skipPermissions === true) args.push('-y')
  for (const dir of options.addDirs ?? []) args.push('--add-dir', dir)
  if (options.allowedTools?.length) args.push('--allowedTools', options.allowedTools.join(','))
  if (options.disallowedTools?.length) args.push('--disallowedTools', options.disallowedTools.join(','))
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt)
  args.push(...(options.extraArgs ?? []))
  args.push('--', prompt)

  const env = {
    ...(options.env ?? process.env),
    CODEBUDDY_CONFIG_DIR: discovery.configDir,
    WORKBUDDY_CONFIG_DIR: discovery.configDir,
  }
  // Current WorkBuddy builds ship only the lite-wb bundle; without this flag
  // the launcher tries to require a `dist/codebuddy` that does not exist.
  if (discovery.liteBundleOnly) env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1'

  return { command: discovery.nodeBinary, args: [discovery.cliEntry, ...args], env, cwd: workspace }
}

/**
 * Start one dispatch and feed its decoded events to the caller.
 * @param {{
 *   invocation: { command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string },
 *   onStart?: (child: import('node:child_process').ChildProcess) => void,
 *   onEvent: (event: object) => void,
 *   onRaw: (line: string) => void,
 *   onStderr?: (chunk: string) => void,
 * }} options
 * @returns {Promise<{ exitCode: number | null, signal: string | null }>}
 */
export function runInvocation(options) {
  const { invocation } = options
  const parser = createParser({ onEvent: options.onEvent })
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      reject(error)
      return
    }
    options.onStart?.(child)
    let buffered = ''
    let stderrBuffered = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      let index = buffered.indexOf('\n')
      while (index >= 0) {
        const line = buffered.slice(0, index).replace(/\r$/, '')
        buffered = buffered.slice(index + 1)
        if (line.trim() !== '') {
          options.onRaw(line)
          parser.push(line)
        }
        index = buffered.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk) => {
      stderrBuffered += chunk
      options.onStderr?.(chunk)
      let index = stderrBuffered.indexOf('\n')
      while (index >= 0) {
        parser.noteDiagnostic(stderrBuffered.slice(0, index).replace(/\r$/, ''))
        stderrBuffered = stderrBuffered.slice(index + 1)
        index = stderrBuffered.indexOf('\n')
      }
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code, signal) => {
      if (buffered.trim() !== '') {
        options.onRaw(buffered)
        parser.push(buffered)
      }
      if (stderrBuffered.trim() !== '') parser.noteDiagnostic(stderrBuffered)
      resolve({ exitCode: code, signal })
    })
  })
}

/**
 * Whether a process id is still alive.
 * @param {number | undefined} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Terminate a dispatch and its whole child tree.
 * @param {number} pid
 * @param {{ graceMs?: number, spawnFn?: typeof spawn }} [options]
 * @returns {Promise<{ signalled: boolean, method: string }>}
 */
export async function terminateTree(pid, options = {}) {
  const graceMs = options.graceMs ?? 2500
  const spawnFn = options.spawnFn ?? spawn
  if (!isProcessAlive(pid)) return { signalled: false, method: 'already-exited' }
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawnFn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('close', () => resolve())
      killer.on('error', () => resolve())
    })
    return { signalled: !isProcessAlive(pid), method: 'taskkill-tree' }
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return { signalled: true, method: 'sigterm-group' }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  return { signalled: true, method: 'sigkill-group' }
}

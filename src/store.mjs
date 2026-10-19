/**
 * Durable run journal for delegated WorkBuddy sessions.
 *
 * Every dispatch owns one run id, one JSON journal, one raw stdout stream and
 * one stderr log. Journals are written atomically so a crashed or killed host
 * can never leave a half-written file that a later `wait_run` misreads.
 *
 * State lives outside WorkBuddy's own data directory on purpose: this kit must
 * never corrupt what the desktop app owns.
 *
 * @module dsh-workbuddy-kit/src/store
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Journal schema version; bumped only on incompatible journal changes. */
export const JOURNAL_VERSION = 1

/**
 * Absolute state directory (`DWB_STATE_DIR` overrides).
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 */
export function resolveStateDir(options = {}) {
  const env = options.env ?? process.env
  const configured = env.DWB_STATE_DIR?.trim()
  if (configured) return configured
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir()
  return join(home, '.dsh-workbuddy')
}

/**
 * Paths owned by one run.
 * @param {string} stateDir
 * @param {string} runId
 * @returns {{ journal: string, stream: string, stderr: string, final: string }}
 */
export function runPaths(stateDir, runId) {
  const dir = join(stateDir, 'runs')
  return {
    journal: join(dir, `${runId}.json`),
    stream: join(dir, `${runId}.stream.jsonl`),
    stderr: join(dir, `${runId}.stderr.log`),
    final: join(dir, `${runId}.final.md`),
  }
}

/**
 * Create every directory this kit writes to.
 * @param {string} stateDir
 * @returns {string} the state directory
 */
export function ensureStateDir(stateDir) {
  mkdirSync(join(stateDir, 'runs'), { recursive: true })
  return stateDir
}

/**
 * Atomic JSON write: write a sibling temp file, then rename over the target.
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

/**
 * Read JSON, returning `undefined` for a missing or unparseable file.
 * @param {string} file
 * @returns {any}
 */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Persist a run journal.
 * @param {string} stateDir
 * @param {object} run
 */
export function saveRun(stateDir, run) {
  const { journal } = runPaths(stateDir, run.runId)
  writeJsonAtomic(journal, { version: JOURNAL_VERSION, ...run, updatedAt: new Date().toISOString() })
}

/**
 * Load one run journal.
 * @param {string} stateDir
 * @param {string} runId
 * @returns {any}
 */
export function loadRun(stateDir, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) return undefined
  return readJson(runPaths(stateDir, runId).journal)
}

/**
 * Run ids ordered newest first.
 * @param {string} stateDir
 * @returns {string[]}
 */
export function listRunIds(stateDir) {
  const dir = join(stateDir, 'runs')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.includes('.tmp'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
    .reverse()
}

/**
 * Load every run journal, newest first.
 * @param {string} stateDir
 * @param {{ limit?: number }} [options]
 * @returns {any[]}
 */
export function listRuns(stateDir, options = {}) {
  const limit = options.limit ?? 50
  const runs = []
  for (const runId of listRunIds(stateDir)) {
    const run = loadRun(stateDir, runId)
    if (run) runs.push(run)
    if (runs.length >= limit) break
  }
  return runs
}

/**
 * Open an append-only byte sink used for the raw child streams.
 * @param {string} file
 * @returns {{ write: (chunk: string | Buffer) => void, close: () => void }}
 */
export function openSink(file) {
  const fd = openSync(file, 'a')
  return {
    write(chunk) {
      try {
        writeSync(fd, chunk)
      } catch {
        /* a closed sink must not break the host call */
      }
    },
    close() {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    },
  }
}

/**
 * Byte size and mtime of a file, or null.
 * @param {string} file
 * @returns {{ bytes: number, mtimeMs: number } | null}
 */
export function fileStat(file) {
  try {
    const stat = statSync(file)
    return { bytes: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Remove a file if present.
 * @param {string} file
 */
export function removeFile(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    /* nothing to clean */
  }
}

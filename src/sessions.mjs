/**
 * WorkBuddy session inventory, transcript reads, and exact archival.
 *
 * WorkBuddy keeps one JSONL transcript per session at
 * `<configDir>/projects/<projectSlug>/<sessionId>.jsonl`. There is no vendor
 * API for "archive this session", so this module never mutates the vendor's
 * own listing: an archive is a verified, digest-stamped copy stored under
 * `<configDir>/session-archive/<date>/<projectSlug>/` plus an index entry in
 * this kit's own state directory. `mode: 'move'` is opt-in and reversible.
 *
 * @module dsh-workbuddy-kit/src/sessions
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { projectSlug, slugToDisplayPath } from './discover.mjs'
import { readSessionTranscript, summarizeSessionFile } from './parse.mjs'
import { fileStat, readJson, resolveStateDir, writeJsonAtomic } from './store.mjs'

/** Session ids accepted by the CLI and therefore by this kit. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** A session touched this recently is treated as possibly live. */
export const DEFAULT_ACTIVE_WINDOW_MS = 120_000

/**
 * List WorkBuddy project directories.
 * @param {{ configDir: string }} input
 * @returns {Array<{ slug: string, displayPath: string | null, path: string, sessionCount: number, latestMtimeMs: number }>}
 */
export function listProjects(input) {
  const projectsDir = join(input.configDir, 'projects')
  if (!existsSync(projectsDir)) return []
  const projects = []
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(projectsDir, entry.name)
    let sessionCount = 0
    let latestMtimeMs = 0
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const stat = fileStat(join(dir, file))
      if (!stat) continue
      sessionCount += 1
      latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs)
    }
    projects.push({
      slug: entry.name,
      displayPath: slugToDisplayPath(entry.name),
      path: dir,
      sessionCount,
      latestMtimeMs,
    })
  }
  projects.sort((left, right) => right.latestMtimeMs - left.latestMtimeMs)
  return projects
}

/**
 * List session transcripts, newest first.
 * @param {{
 *   configDir: string,
 *   project?: string,
 *   cwd?: string,
 *   limit?: number,
 *   summarize?: boolean,
 * }} input
 * @returns {Array<{
 *   sessionId: string,
 *   project: string,
 *   path: string,
 *   bytes: number,
 *   mtimeMs: number,
 *   hasResult?: boolean,
 *   turns?: number,
 *   model?: string | null,
 *   firstPrompt?: string,
 * }>}
 */
export function listSessions(input) {
  const limit = input.limit ?? 20
  const summarize = input.summarize ?? true
  const projectFilter = input.cwd ? projectSlug(input.cwd) : input.project
  const projectsDir = join(input.configDir, 'projects')
  if (!existsSync(projectsDir)) return []
  const rows = []
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (projectFilter && entry.name !== projectFilter) continue
    const dir = join(projectsDir, entry.name)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const sessionId = file.slice(0, -'.jsonl'.length)
      if (!SESSION_ID_PATTERN.test(sessionId)) continue
      const path = join(dir, file)
      const stat = fileStat(path)
      if (!stat) continue
      const row = {
        sessionId,
        project: entry.name,
        path,
        bytes: stat.bytes,
        mtimeMs: stat.mtimeMs,
      }
      if (summarize) {
        try {
          const summary = summarizeSessionFile(path)
          row.hasResult = summary.hasResult
          row.turns = summary.turns
          row.model = summary.model
          row.firstPrompt = summary.firstPrompt.slice(0, 300)
        } catch {
          row.unreadable = true
        }
      }
      rows.push(row)
    }
  }
  rows.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return rows.slice(0, limit)
}

/**
 * Locate the transcript file for one exact session id.
 * @param {{ configDir: string, sessionId: string, project?: string }} input
 * @returns {string | null}
 */
export function findSessionFile(input) {
  if (!SESSION_ID_PATTERN.test(input.sessionId)) return null
  const projectsDir = join(input.configDir, 'projects')
  if (!existsSync(projectsDir)) return null
  const projects = input.project
    ? [input.project]
    : readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
  for (const project of projects) {
    if (project.includes('..') || /[\\/]/.test(project)) continue
    const candidate = join(projectsDir, project, `${input.sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Read one session transcript.
 * @param {{ configDir: string, sessionId: string, project?: string }} input
 * @returns {{
 *   found: boolean,
 *   sessionId: string,
 *   project: string,
 *   path: string | null,
 *   bytes: number,
 *   cwd: string | null,
 *   truncated: boolean,
 *   entries: Array<object>,
 * }}
 */
export function readSession(input) {
  const path = findSessionFile(input)
  if (!path) {
    return { found: false, sessionId: input.sessionId, project: input.project ?? '', path: null, bytes: 0, cwd: null, truncated: false, entries: [] }
  }
  const stat = fileStat(path)
  const project = path.slice(join(input.configDir, 'projects').length + 1).split(/[\\/]/)[0]
  const transcript = readSessionTranscript(path, { readFile: (target) => readFileSync(target, 'utf8') })
  return {
    found: true,
    sessionId: transcript.sessionId ?? input.sessionId,
    project,
    path,
    bytes: stat?.bytes ?? 0,
    cwd: transcript.cwd,
    truncated: transcript.truncated,
    entries: transcript.entries,
  }
}

/**
 * Read the archive index (oldest first).
 * @param {string} stateDir
 * @returns {any[]}
 */
export function readArchiveIndex(stateDir) {
  const value = readJson(join(stateDir, 'archive-index.json'))
  return Array.isArray(value) ? value : []
}

/**
 * Append one entry to the archive index.
 * @param {string} stateDir
 * @param {object} entry
 */
function appendArchiveIndex(stateDir, entry) {
  const indexFile = join(stateDir, 'archive-index.json')
  const entries = readArchiveIndex(stateDir)
  entries.push(entry)
  writeJsonAtomic(indexFile, entries)
}

/**
 * Archive exactly one session transcript.
 *
 * Refusals are returned as structured results instead of thrown errors so a
 * host can report `archived: false` with the real reason rather than imply
 * success.
 *
 * @param {{
 *   configDir: string,
 *   sessionId: string,
 *   project?: string,
 *   mode?: 'copy' | 'move',
 *   requireTerminal?: boolean,
 *   overwrite?: boolean,
 *   force?: boolean,
 *   activeSessionIds?: string[],
 *   completedSessionIds?: string[],
 *   activeWindowMs?: number,
 *   stateDir?: string,
 *   runId?: string,
 * }} input
 * @returns {{
 *   archived: boolean,
 *   reason?: string,
 *   sessionId: string,
 *   mode: string,
 *   sourcePath: string | null,
 *   targetPath: string | null,
 *   manifestPath: string | null,
 *   bytes: number,
 *   sha256: string | null,
 *   date: string,
 * }}
 */
export function archiveSession(input) {
  const mode = input.mode ?? 'copy'
  const requireTerminal = input.requireTerminal ?? true
  const activeWindowMs = input.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS
  const stateDir = input.stateDir ?? resolveStateDir()
  const date = new Date().toISOString().slice(0, 10)
  const refuse = (reason, extra = {}) => ({
    archived: false,
    reason,
    sessionId: input.sessionId,
    mode,
    sourcePath: null,
    targetPath: null,
    manifestPath: null,
    bytes: 0,
    sha256: null,
    date,
    ...extra,
  })

  if (!SESSION_ID_PATTERN.test(input.sessionId)) return refuse('invalid-session-id')
  const sourcePath = findSessionFile(input)
  if (!sourcePath) return refuse('session-not-found')
  const project = sourcePath.slice(join(input.configDir, 'projects').length + 1).split(/[\\/]/)[0]
  const stat = fileStat(sourcePath)
  if (!stat) return refuse('session-not-readable')

  if ((input.activeSessionIds ?? []).includes(input.sessionId)) {
    return refuse('session-is-active', { sourcePath })
  }
  const ageMs = Date.now() - stat.mtimeMs
  const observedTerminal = (input.completedSessionIds ?? []).includes(input.sessionId)
  if (!input.force && !observedTerminal && ageMs < activeWindowMs) {
    return refuse('session-may-be-active', {
      sourcePath,
      ageMs,
      hint: `transcript was written ${Math.round(ageMs / 1000)}s ago and this kit has no terminal run for it; pass force: true to archive anyway`,
    })
  }

  let summary
  try {
    summary = summarizeSessionFile(sourcePath)
  } catch {
    return refuse('session-not-readable', { sourcePath })
  }
  if (requireTerminal && !summary.hasResult) {
    return refuse('session-not-terminal', { sourcePath })
  }

  const targetDir = join(input.configDir, 'session-archive', date, project)
  const targetPath = join(targetDir, `${input.sessionId}.jsonl`)
  if (existsSync(targetPath) && !input.overwrite) {
    return refuse('target-exists', { sourcePath, targetPath })
  }
  try {
    mkdirSync(targetDir, { recursive: true })
    if (mode === 'move') renameSync(sourcePath, targetPath)
    else copyFileSync(sourcePath, targetPath)
  } catch (error) {
    return refuse('archive-write-failed', { sourcePath, targetPath, error: String(error?.message ?? error) })
  }

  const bytes = readFileSync(targetPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const manifestPath = join(targetDir, `${input.sessionId}.manifest.json`)
  const entry = {
    archivedAt: new Date().toISOString(),
    sessionId: input.sessionId,
    project,
    mode,
    sourcePath,
    targetPath,
    manifestPath,
    bytes: bytes.byteLength,
    sha256,
    cliModel: summary.model ?? null,
    turns: summary.turns,
    runId: input.runId ?? null,
    cwd: summary.cwd ?? null,
  }
  try {
    writeFileSync(manifestPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    appendArchiveIndex(stateDir, entry)
  } catch (error) {
    return {
      ...refuse('manifest-write-failed', { sourcePath, targetPath }),
      copied: true,
      error: String(error?.message ?? error),
    }
  }
  return {
    archived: true,
    sessionId: input.sessionId,
    mode,
    sourcePath,
    targetPath,
    manifestPath,
    bytes: bytes.byteLength,
    sha256,
    date,
    project,
  }
}

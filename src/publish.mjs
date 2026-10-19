/**
 * Make a CLI-dispatched session visible in the desktop WorkBuddy app.
 *
 * Why this is needed: the bundled CLI writes a complete transcript to
 * `<configDir>/projects/<slug>/<sessionId>.jsonl` but never inserts a row into
 * the app's own index (`workbuddy.db` → `sessions`). The desktop list query is
 *
 *   SELECT … FROM sessions
 *    WHERE transport = 'local' AND deleted_at IS NULL
 *      AND (user_id = ? OR user_id = '')
 *      AND id IN (…)
 *
 * so a transcript without a row is invisible no matter how complete it is.
 * Publishing inserts that one row (+ an optional usage row); unpublishing
 * deletes exactly what publishing created.
 *
 * This is the only place in the kit that writes vendor state, so it is an
 * explicit tool, refuses anything it cannot verify, records every insert in
 * `<stateDir>/published.jsonl`, and never deletes a row it did not create.
 *
 * @module dsh-workbuddy-kit/src/publish
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { projectSlug } from './discover.mjs'
import { summarizeSessionFile } from './parse.mjs'
import { findSessionFile } from './sessions.mjs'
import { readJson, resolveStateDir } from './store.mjs'

/** Cached `node:sqlite` module. */
let sqliteModule

/**
 * @returns {Promise<{ DatabaseSync: any } | null>}
 */
async function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule
  try {
    sqliteModule = await import('node:sqlite')
  } catch {
    sqliteModule = null
  }
  return sqliteModule
}

/**
 * Path of the app's session index.
 * @param {string} configDir
 * @returns {string}
 */
export function databasePath(configDir) {
  return join(configDir, 'workbuddy.db')
}

/**
 * The desktop app's current user id.
 *
 * The app filters its list with `user_id = ? OR user_id = ''`; a real id is
 * still preferable so the session also survives account switching. Sources, in
 * order: the newest existing session row, a `user-<id>` directory, a
 * `security/<id>` directory.
 *
 * @param {{ configDir: string, DatabaseSync?: any }} input
 * @returns {string}
 */
export function resolveUserId(input) {
  const { configDir } = input
  if (input.DatabaseSync && existsSync(databasePath(configDir))) {
    try {
      const db = new input.DatabaseSync(databasePath(configDir), { readOnly: true })
      const row = db
        .prepare("select user_id from sessions where user_id is not null and user_id != '' order by last_activity_at desc limit 1")
        .get()
      db.close()
      if (row?.user_id) return row.user_id
    } catch {
      /* fall through to the directory hints */
    }
  }
  for (const prefix of ['user-', 'security']) {
    try {
      const match = readdirSync(configDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map((entry) => entry.name.slice(prefix.length))
        .find((name) => /^[0-9a-f-]{8,}$/i.test(name))
      if (match) return match
    } catch {
      /* ignore */
    }
  }
  return ''
}

/**
 * Normalize a workspace path the way the app stores it (`E:/Code/x`).
 * @param {string} value
 * @returns {string}
 */
export function normalizeCwd(value) {
  return value
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    // the app stores the drive letter upper-cased (`E:/Code/x`); the CLI writes
    // it lower-cased, so normalize or the same workspace shows up twice
    .replace(/^([a-z]):/, (_match, drive) => `${drive.toUpperCase()}:`)
}

/**
 * Whether a dispatch should also register itself in the desktop app index.
 *
 * Default is ON: the point of this kit is that a dispatched conversation shows
 * up where the user already looks. alse is the explicit opt-out.
 * @param {unknown} value
 * @returns {boolean}
 */
export function resolvePublishFlag(value) {
  return value !== false
}

/**
 * Compact, list-friendly title. The desktop sidebar truncates around 50
 * characters, so a long prompt would swallow the row.
 * @param {string | undefined} source
 * @param {string} sessionId
 * @returns {string}
 */
export function buildTitle(source, sessionId) {
  const prefix = '【DSH 派发】'
  const firstLine = typeof source === 'string' ? source.split('\n')[0].trim() : ''
  if (firstLine === '') return `${prefix}${sessionId.slice(0, 8)}`
  const body = firstLine.replace(/^【DSH 派发】/, '').trim()
  const clipped = body.length <= 48 ? body : `${body.slice(0, 47)}…`
  return `${prefix}${clipped}`
}

/**
 * Read the publish ledger.
 * @param {string} stateDir
 * @returns {any[]}
 */
export function readPublishedLedger(stateDir) {
  const path = join(stateDir, 'published.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/**
 * Append one publish event.
 * @param {string} stateDir
 * @param {object} entry
 */
function appendPublished(stateDir, entry) {
  writeFileSync(join(stateDir, 'published.jsonl'), `${JSON.stringify(entry)}\n`, { flag: 'a', encoding: 'utf8' })
}

/**
 * Insert the app row for one CLI session.
 *
 * @param {{
 *   configDir: string,
 *   sessionId: string,
 *   project?: string,
 *   title?: string,
 *   stateDir?: string,
 *   status?: string,
 * }} input
 * @returns {Promise<object>}
 */
export async function publishSession(input) {
  const stateDir = input.stateDir ?? resolveStateDir()
  const refuse = (reason, extra = {}) => ({ published: false, reason, sessionId: input.sessionId, ...extra })
  // A run id is the friendlier selector: the caller already holds it from a dispatch.
  if (!input.sessionId && input.runId) {
    const run = findRunByRunId(stateDir, input.runId)
    if (!run) return refuse('unknown-run-id', { runId: input.runId })
    if (typeof run.sessionId !== 'string') return refuse('run-has-no-session-id', { runId: input.runId, state: run.state })
    input = { ...input, sessionId: run.sessionId, project: input.project ?? run.projectSlug }
  }
  if (!input.sessionId) return refuse('sessionId-or-runId-required')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.sessionId)) return refuse('invalid-session-id')
  const transcript = findSessionFile({ configDir: input.configDir, sessionId: input.sessionId, project: input.project })
  if (!transcript) return refuse('session-not-found')
  const sqlite = await loadSqlite()
  if (!sqlite) return refuse('node:sqlite unavailable in this runtime (needs Node >= 22.13)')
  const dbPath = databasePath(input.configDir)
  if (!existsSync(dbPath)) return refuse('workbuddy.db not found', { dbPath })

  let summary
  try {
    summary = summarizeSessionFile(transcript)
  } catch (error) {
    return refuse('session-not-readable', { error: String(error?.message ?? error) })
  }
  const project = transcript.slice(join(input.configDir, 'projects').length + 1).split(/[\\/]/)[0]
  const cwd = normalizeCwd(summary.cwd ?? input.project ?? '')
  if (cwd === '') return refuse('session-has-no-cwd', { transcript })
  const userId = resolveUserId({ configDir: input.configDir, DatabaseSync: sqlite.DatabaseSync })
  const now = Date.now()
  const run = findRunForSession(stateDir, input.sessionId)
  const title = buildTitle(input.title ?? run?.promptPreview ?? summary.firstPrompt, input.sessionId)
  const createdAt = Date.parse(run?.createdAt ?? '') || now
  const updatedAt = Date.parse(run?.terminalAt ?? run?.updatedAt ?? '') || now
  const bytes = readFileSync(transcript).byteLength

  const row = {
    id: input.sessionId,
    cwd,
    user_id: userId,
    title,
    custom_title: null,
    status: input.status ?? 'completed',
    created_at: createdAt,
    updated_at: updatedAt,
    last_activity_at: updatedAt,
    deleted_at: null,
    is_playground: 0,
    source_mode: 'craft',
    is_background_automation: null,
    mode: 'craft',
    transport: 'local',
    model: run?.model ?? summary.model ?? null,
    permission_mode: run?.permissionMode ?? null,
    unread: 0,
  }

  let db
  try {
    db = new sqlite.DatabaseSync(dbPath)
    db.exec('PRAGMA busy_timeout = 8000')
  } catch (error) {
    return refuse('cannot-open-database-for-write', { dbPath, error: String(error?.message ?? error) })
  }
  try {
    const existing = db.prepare('select id, cwd, user_id, title, status, transport, source_mode from sessions where id = ?').get(input.sessionId)
    if (existing) {
      // The goal state is "the app lists this session"; reaching it twice is not
      // an error, it just means a retry is a no-op.
      return {
        published: true,
        alreadyIndexed: true,
        sessionId: input.sessionId,
        dbPath,
        row: existing,
        note: 'already indexed; nothing to write',
      }
    }
    const columns = Object.keys(row)
    const placeholders = columns.map(() => '?').join(', ')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`INSERT INTO sessions (${columns.join(', ')}) VALUES (${placeholders})`).run(...columns.map((column) => row[column]))
      db.prepare(
        'INSERT OR REPLACE INTO session_usage (session_id, used, size, updated_at, credit_json) VALUES (?, ?, ?, ?, ?)',
      ).run(input.sessionId, 0, bytes, updatedAt, null)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* nothing to roll back */
      }
      throw error
    }
    const readBack = db.prepare('select id, cwd, user_id, title, status, transport, source_mode, model from sessions where id = ?').get(input.sessionId)
    appendPublished(stateDir, {
      publishedAt: new Date().toISOString(),
      sessionId: input.sessionId,
      project,
      dbPath,
      transcript,
      cwd,
      userId,
      title,
      bytes,
      model: row.model,
    })
    return {
      published: true,
      sessionId: input.sessionId,
      dbPath,
      transcript,
      row: readBack,
      userIdUsed: userId === '' ? '(empty: matches any signed-in user)' : userId,
      note: 'The row now satisfies the desktop list query. If the app was already open, switch sessions or restart it so the list reloads.',
    }
  } catch (error) {
    return refuse('publish-write-failed', { dbPath, error: String(error?.message ?? error) })
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Find a run journal by its run id.
 * @param {string} stateDir
 * @param {string} runId
 * @returns {any | undefined}
 */
function findRunByRunId(stateDir, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) return undefined
  return readJson(join(stateDir, 'runs', `${runId}.json`))
}

/**
 * Find the run journal that produced a session id.
 * @param {string} stateDir
 * @param {string} sessionId
 * @returns {any | undefined}
 */
function findRunForSession(stateDir, sessionId) {
  const dir = join(stateDir, 'runs')
  if (!existsSync(dir)) return undefined
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const run = readJson(join(dir, name))
    if (run?.sessionId === sessionId) return run
  }
  return undefined
}

/**
 * Remove the row this kit inserted (and nothing else).
 * @param {{ configDir: string, sessionId: string, stateDir?: string, force?: boolean }} input
 * @returns {Promise<object>}
 */
export async function unpublishSession(input) {
  const stateDir = input.stateDir ?? resolveStateDir()
  const refuse = (reason, extra = {}) => ({ unpublished: false, reason, sessionId: input.sessionId, ...extra })
  const ledger = readPublishedLedger(stateDir).filter((entry) => entry.sessionId === input.sessionId)
  if (ledger.length === 0 && input.force !== true) {
    return refuse('not-published-by-this-kit', { hint: 'pass force: true only if you know the row is safe to delete' })
  }
  const sqlite = await loadSqlite()
  if (!sqlite) return refuse('node:sqlite unavailable')
  const dbPath = databasePath(input.configDir)
  if (!existsSync(dbPath)) return refuse('workbuddy.db not found', { dbPath })
  let db
  try {
    db = new sqlite.DatabaseSync(dbPath)
    db.exec('PRAGMA busy_timeout = 8000')
    db.exec('BEGIN IMMEDIATE')
    const deleted = db.prepare('delete from sessions where id = ?').run(input.sessionId)
    db.prepare('delete from session_usage where session_id = ?').run(input.sessionId)
    db.exec('COMMIT')
    appendPublished(stateDir, {
      publishedAt: new Date().toISOString(),
      unpublished: true,
      sessionId: input.sessionId,
      dbPath,
      deletedRows: Number(deleted?.changes ?? 0),
    })
    return {
      unpublished: true,
      sessionId: input.sessionId,
      dbPath,
      deletedRows: Number(deleted?.changes ?? 0),
      transcriptKept: findSessionFile({ configDir: input.configDir, sessionId: input.sessionId }) !== null,
      note: 'The transcript file is never touched; only the index row this kit added is removed.',
    }
  } catch (error) {
    return refuse('unpublish-write-failed', { dbPath, error: String(error?.message ?? error) })
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

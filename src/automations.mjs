/**
 * Read-only access to the **desktop WorkBuddy scheduler**.
 *
 * The desktop app keeps its scheduled tasks in SQLite, not in files:
 * `<configDir>/workbuddy.db` → `automations`, `automation_runs`,
 * `automation_runtime_state`. (`<configDir>/automations.db` exists but is a
 * zero-byte leftover; it is not the store.)
 *
 * Everything here opens the database `readOnly: true` — WAL readers do not
 * disturb the running desktop app, and this kit never writes scheduler state.
 * Task prompts are stored in full inside the database; they are excluded by
 * default and only included on explicit request, bounded.
 *
 * @module dsh-workbuddy-kit/src/automations
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { resolveConfigDir } from './discover.mjs'

/** Database file holding the desktop scheduler. */
const DB_FILE = 'workbuddy.db'

/** Bound for any prompt/title text this module returns. */
const TEXT_LIMIT = 2000

/** Cached `node:sqlite` module (null when the runtime has no SQLite). */
let sqliteModule

/**
 * Load `node:sqlite` once.
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
 * @param {unknown} value
 * @returns {string | null}
 */
function iso(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return new Date(numeric).toISOString()
}

/**
 * Human description of a schedule row.
 * @param {{ schedule_type?: string | null, rrule?: string | null }} row
 * @returns {string}
 */
export function describeSchedule(row) {
  const rrule = typeof row.rrule === 'string' ? row.rrule : ''
  const type = typeof row.schedule_type === 'string' ? row.schedule_type : 'unknown'
  if (type === 'once') return 'once'
  const interval = Number(/INTERVAL=(\d+)/.exec(rrule)?.[1] ?? 1)
  const freq = /FREQ=([A-Z]+)/.exec(rrule)?.[1] ?? ''
  if (freq === 'HOURLY') return interval === 1 ? 'hourly' : `every ${interval}h`
  if (freq === 'DAILY') {
    const hour = /BYHOUR=(\d+)/.exec(rrule)?.[1]
    const minute = /BYMINUTE=(\d+)/.exec(rrule)?.[1]
    return `daily ${String(hour ?? '0').padStart(2, '0')}:${String(minute ?? '0').padStart(2, '0')}`
  }
  if (freq === 'WEEKLY') return 'weekly'
  if (freq === 'MINUTELY') return interval === 1 ? 'every minute' : `every ${interval}m`
  return rrule === '' ? type : `${type}: ${rrule}`
}

/**
 * Open the WorkBuddy database read-only.
 * @param {{ configDir?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ db: any, path: string, close: () => void } | { unavailable: string }>}
 */
export async function openWorkBuddyDb(options = {}) {
  const configDir = options.configDir ?? resolveConfigDir({ env: options.env })
  const path = join(configDir, DB_FILE)
  if (!existsSync(path)) return { unavailable: `database not found: ${path}` }
  const sqlite = await loadSqlite()
  if (!sqlite) return { unavailable: 'this Node.js runtime has no node:sqlite module (needs Node >= 22.13)' }
  try {
    const db = new sqlite.DatabaseSync(path, { readOnly: true })
    return { db, path, close: () => { try { db.close() } catch { /* already closed */ } } }
  } catch (error) {
    return { unavailable: `cannot open ${path} read-only: ${String(error?.message ?? error)}` }
  }
}

/**
 * @param {any} db
 * @param {string} name
 * @returns {boolean}
 */
function hasTable(db, name) {
  try {
    const row = db.prepare("select name from sqlite_master where type='table' and name=?").get(name)
    return Boolean(row)
  } catch {
    return false
  }
}

/**
 * Read the desktop scheduler inventory.
 *
 * Soft-deleted rows keep `status = 'ACTIVE'` with a non-null `deleted_at`; the
 * `softDeleted` flag is therefore the reliable liveness signal, not `status`.
 *
 * @param {{
 *   configDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   includeDeleted?: boolean,
 *   limit?: number,
 *   includePrompt?: boolean,
 * }} [options]
 * @returns {Promise<{
 *   available: boolean,
 *   reason?: string,
 *   dbPath?: string,
 *   counts?: { live: number, softDeleted: number, returned: number },
 *   automations: Array<object>,
 * }>}
 */
export async function listAutomations(options = {}) {
  const opened = await openWorkBuddyDb(options)
  if (opened.unavailable) return { available: false, reason: opened.unavailable, automations: [] }
  const { db, path, close } = opened
  try {
    if (!hasTable(db, 'automations')) {
      return { available: false, reason: 'this WorkBuddy database has no automations table', dbPath: path, automations: [] }
    }
    const includeDeleted = options.includeDeleted === true
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
    const columns = [
      'id', 'name', 'status', 'schedule_type', 'rrule', 'scheduled_at', 'next_run_at', 'last_run_at',
      'model_id', 'permission_mode', 'workspace_scope', 'cwds', 'push_to_wechat', 'push_to_wecom_bot',
      'expert_id', 'deleted_at', 'created_at', 'updated_at', 'valid_from', 'valid_until',
    ].filter((column) => {
      const present = new Set(db.prepare('pragma table_info("automations")').all().map((row) => row.name))
      return present.has(column)
    })
    if (options.includePrompt === true) columns.push('prompt')
    const where = includeDeleted ? '' : 'where deleted_at is null'
    const rows = db
      .prepare(`select ${columns.join(',')} from automations ${where} order by (next_run_at is null), next_run_at asc limit ?`)
      .all(limit)
    const runtime = new Map(
      hasTable(db, 'automation_runtime_state')
        ? db.prepare('select * from automation_runtime_state').all().map((row) => [row.automation_id, row])
        : [],
    )
    const lastRuns = new Map(
      hasTable(db, 'automation_runs')
        ? db
            .prepare(
              `select automation_id, status, created_at, result_success, failure_code
                 from automation_runs
                where rowid in (select max(rowid) from automation_runs group by automation_id)`,
            )
            .all()
            .map((row) => [row.automation_id, row])
        : [],
    )
    const automations = rows.map((row) => {
      const state = runtime.get(row.id) ?? {}
      const lastRun = lastRuns.get(row.id) ?? {}
      const softDeleted = row.deleted_at !== null && row.deleted_at !== undefined
      return {
        id: row.id,
        name: typeof row.name === 'string' ? row.name.slice(0, 300) : row.name,
        status: row.status ?? null,
        softDeleted,
        live: Boolean(!softDeleted && row.status === 'ACTIVE'),
        schedule: describeSchedule(row),
        scheduleType: row.schedule_type ?? null,
        rrule: row.rrule ?? null,
        nextRunAt: iso(row.next_run_at),
        lastRunAt: iso(row.last_run_at),
        model: row.model_id ?? null,
        permissionMode: row.permission_mode ?? null,
        workspaceScope: row.workspace_scope ?? null,
        cwds: parseJsonArray(row.cwds),
        push: { wechat: row.push_to_wechat === 1, wecomBot: row.push_to_wecom_bot === 1 },
        expertId: row.expert_id ?? null,
        running: state.running === 1,
        lastError: typeof state.last_error === 'string' ? state.last_error.slice(0, 300) : null,
        lastRunStatus: lastRun.status ?? null,
        lastRunSuccess: lastRun.result_success === null || lastRun.result_success === undefined ? null : lastRun.result_success === 1,
        lastRunFailureCode: lastRun.failure_code ?? null,
        lastRunRecordedAt: iso(lastRun.created_at),
        deletedAt: iso(row.deleted_at),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        ...(options.includePrompt === true && typeof row.prompt === 'string'
          ? { promptBytes: Buffer.byteLength(row.prompt, 'utf8'), prompt: row.prompt.slice(0, TEXT_LIMIT) }
          : {}),
      }
    })
    const counts = {
      live: db.prepare('select count(*) c from automations where deleted_at is null').get().c,
      softDeleted: db.prepare('select count(*) c from automations where deleted_at is not null').get().c,
      returned: automations.length,
    }
    return { available: true, dbPath: path, counts, automations }
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error), dbPath: path, automations: [] }
  } finally {
    close()
  }
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseJsonArray(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/**
 * Resolve one automation by exact id, then by case-insensitive name substring.
 * @param {any[]} automations
 * @param {string} selector
 * @returns {any | undefined}
 */
function resolveAutomation(automations, selector) {
  const exact = automations.find((entry) => entry.id === selector)
  if (exact) return exact
  const needle = selector.toLowerCase()
  return automations.find((entry) => String(entry.name ?? '').toLowerCase().includes(needle))
}

/**
 * Read the run history of one automation (or of the whole scheduler).
 * @param {{
 *   configDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   automationId?: string,
 *   name?: string,
 *   limit?: number,
 *   failuresOnly?: boolean,
 *   includeTitle?: boolean,
 * }} [options]
 * @returns {Promise<{
 *   available: boolean,
 *   reason?: string,
 *   automation?: object | null,
 *   runs?: Array<object>,
 *   totals?: object,
 * }>}
 */
export async function getAutomationRuns(options = {}) {
  const selector = options.automationId ?? options.name
  if (!selector) return { available: false, reason: 'automationId or name is required' }
  const inventory = await listAutomations({ ...options, includeDeleted: true, limit: 200, includePrompt: false })
  if (!inventory.available) return { available: false, reason: inventory.reason }
  const automation = resolveAutomation(inventory.automations, selector)
  if (!automation) return { available: false, reason: `no automation matches ${JSON.stringify(selector)}` }
  const opened = await openWorkBuddyDb(options)
  if (opened.unavailable) return { available: false, reason: opened.unavailable }
  const { db, close } = opened
  try {
    if (!hasTable(db, 'automation_runs')) return { available: false, reason: 'no automation_runs table in this database' }
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200))
    const failuresOnly = options.failuresOnly === true
    const where = ['automation_id = ?', ...(failuresOnly ? ['result_success = 0'] : [])].join(' and ')
    const columns = [
      'thread_id', 'status', 'created_at', 'read_at', 'result_success', 'failure_code', 'reason_code',
      ...(options.includeTitle === false ? [] : ['thread_title']),
    ]
    const rows = db
      .prepare(`select ${columns.join(',')} from automation_runs where ${where} order by rowid desc limit ?`)
      .all(automation.id, limit)
    const totals = db
      .prepare(
        `select count(*) total,
                sum(case when result_success = 1 then 1 else 0 end) succeeded,
                sum(case when result_success = 0 then 1 else 0 end) failed,
                max(created_at) lastAt
           from automation_runs where automation_id = ?`,
      )
      .get(automation.id)
    const failureCodes = db
      .prepare(
        `select failure_code, count(*) c from automation_runs
          where automation_id = ? and failure_code is not null group by failure_code order by c desc, failure_code asc`,
      )
      .all(automation.id)
    return {
      available: true,
      automation,
      runs: rows.map((row) => ({
        threadId: row.thread_id,
        status: row.status ?? null,
        createdAt: iso(row.created_at),
        read: row.read_at !== null && row.read_at !== undefined,
        success: row.result_success === null || row.result_success === undefined ? null : row.result_success === 1,
        failureCode: row.failure_code ?? null,
        reasonCode: row.reason_code ?? null,
        ...(typeof row.thread_title === 'string' ? { titlePreview: row.thread_title.slice(0, 300) } : {}),
      })),
      totals: {
        total: totals.total ?? 0,
        succeeded: totals.succeeded ?? 0,
        failed: totals.failed ?? 0,
        lastAt: iso(totals.lastAt),
        failureCodes: failureCodes.map((row) => ({ code: row.failure_code, count: row.c })),
      },
    }
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) }
  } finally {
    close()
  }
}

/**
 * Scheduler-level health: live vs soft-deleted tasks, run outcomes, failure
 * codes, per-task cadence.
 * @param {{ configDir?: string, env?: NodeJS.ProcessEnv, limit?: number }} [options]
 * @returns {Promise<object>}
 */
export async function automationHealth(options = {}) {
  const inventory = await listAutomations({ ...options, includeDeleted: true, limit: 200 })
  if (!inventory.available) return { available: false, reason: inventory.reason }
  const opened = await openWorkBuddyDb(options)
  if (opened.unavailable) return { available: false, reason: opened.unavailable }
  const { db, close } = opened
  try {
    const runsByResult = hasTable(db, 'automation_runs')
      ? db.prepare('select result_success, count(*) c from automation_runs group by result_success').all()
      : []
    const failureCodes = hasTable(db, 'automation_runs')
      ? db
          .prepare(
            `select failure_code, count(*) c from automation_runs
              where failure_code is not null group by failure_code order by c desc, failure_code asc`,
          )
          .all()
      : []
    const perTask = hasTable(db, 'automation_runs')
      ? db
          .prepare(
            `select a.id, a.name, a.status, a.deleted_at, count(r.rowid) c, max(r.created_at) lastAt
               from automations a left join automation_runs r on r.automation_id = a.id
              group by a.id order by lastAt desc`,
          )
          .all()
      : []
    const totalRuns = runsByResult.reduce((sum, row) => sum + row.c, 0)
    const failed = runsByResult.find((row) => row.result_success === 0)?.c ?? 0
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200))
    return {
      available: true,
      dbPath: inventory.dbPath,
      counts: inventory.counts,
      runs: {
        total: totalRuns,
        succeeded: totalRuns - failed,
        failed,
        successRate: totalRuns === 0 ? null : Number(((totalRuns - failed) / totalRuns).toFixed(4)),
        failureCodes: failureCodes.map((row) => ({ code: row.failure_code, count: row.c })),
      },
      perTask: perTask.slice(0, limit).map((row) => ({
        id: row.id,
        name: typeof row.name === 'string' ? row.name.slice(0, 200) : row.name,
        live: row.deleted_at === null || row.deleted_at === undefined,
        runs: row.c,
        lastRunAt: iso(row.lastAt),
      })),
      overdue: inventory.automations
        .filter((entry) => entry.live && entry.nextRunAt !== null && Date.parse(entry.nextRunAt) < Date.now() - 15 * 60_000)
        .map((entry) => ({ id: entry.id, name: entry.name, nextRunAt: entry.nextRunAt, schedule: entry.schedule })),
    }
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) }
  } finally {
    close()
  }
}

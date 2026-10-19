import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { automationHealth, describeSchedule, getAutomationRuns, listAutomations } from '../src/automations.mjs'

/** `node:sqlite` ships with the runtimes this kit targets; skip cleanly if not. */
const sqlite = await import('node:sqlite').catch(() => null)
const skip = sqlite === null ? 'node:sqlite is unavailable in this runtime' : false

const PROMPT = 'p'.repeat(5000)

/**
 * Build a fixture database that mirrors the desktop scheduler tables.
 * @returns {string} configDir
 */
function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), 'dwb-auto-'))
  const db = new sqlite.DatabaseSync(join(configDir, 'workbuddy.db'))
  db.exec(`
    create table automations (
      id text primary key, name text, prompt text, status text, schedule_type text,
      rrule text, scheduled_at integer, next_run_at integer, last_run_at integer,
      model_id text, permission_mode text, workspace_scope text, cwds text,
      push_to_wechat integer, push_to_wecom_bot integer, expert_id text,
      deleted_at integer, created_at integer, updated_at integer, valid_from integer, valid_until integer
    );
    create table automation_runs (
      thread_id text primary key, automation_id text, status text, read_at integer,
      thread_title text, source_cwd text, runs_json text, result_success integer,
      metadata_json text, created_at integer, updated_at integer, failure_code text, reason_code text
    );
    create table automation_runtime_state (
      automation_id text primary key, last_run_at integer, last_error text, running integer,
      running_started_at integer, running_conversation_id text, metadata_json text
    );
  `)
  const now = Date.now()
  const insert = db.prepare(`insert into automations
    (id,name,prompt,status,schedule_type,rrule,next_run_at,last_run_at,model_id,permission_mode,
     workspace_scope,cwds,push_to_wechat,push_to_wecom_bot,expert_id,deleted_at,created_at,updated_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  insert.run('a-hourly', 'guard task', PROMPT, 'ACTIVE', 'recurring', 'FREQ=HOURLY;INTERVAL=1', now + 3600_000, null,
    'custom-local:m', 'fullAccess', 'workspace', '["E:\\\\Code\\\\demo"]', 0, 0, null, null, now - 1000, now)
  insert.run('a-daily', 'daily report', 'short', 'ACTIVE', 'recurring', 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0', now + 86_400_000, null,
    'hy3', 'fullAccess', 'workspace', '["E:\\\\Code\\\\demo"]', 1, 0, null, null, now - 1000, now)
  insert.run('a-once', 'one shot', 'x', 'ACTIVE', 'once', null, null, null,
    'hy3', null, 'workspace', '["E:\\\\Code\\\\demo"]', 0, 0, null, null, now - 1000, now)
  insert.run('a-deleted', 'zombie task', 'x', 'ACTIVE', 'recurring', 'FREQ=HOURLY;INTERVAL=6', now - 90_000_000, null,
    'hy3', 'fullAccess', 'workspace', '["E:\\\\Code\\\\demo"]', 0, 0, null, now - 5000, now - 10_000, now - 5000)
  const run = db.prepare(`insert into automation_runs
    (thread_id,automation_id,status,read_at,thread_title,runs_json,result_success,created_at,updated_at,failure_code,reason_code)
    values (?,?,?,?,?,?,?,?,?,?,?)`)
  run.run('a-hourly:1', 'a-hourly', 'ACCEPTED', null, 'ok run', null, 1, now - 7200_000, now - 7200_000, null, null)
  run.run('a-hourly:2', 'a-hourly', 'ACCEPTED', null, 'rate limited run', null, 0, now - 3600_000, now - 3600_000, 'automation-rate-limited', null)
  run.run('a-hourly:3', 'a-hourly', 'ACCEPTED', null, 'refused run', null, 0, now - 60_000, now - 60_000, 'automation-request-refused', 'interrupted')
  db.prepare('insert into automation_runtime_state (automation_id,last_run_at,last_error,running) values (?,?,?,?)')
    .run('a-hourly', now - 60_000, 'boom', 1)
  db.prepare('insert into automation_runtime_state (automation_id,last_run_at,last_error,running) values (?,?,?,?)')
    .run('a-deleted', now - 5000, null, 0)
  db.close()
  return configDir
}

test('describeSchedule turns rrules into readable cadence', () => {
  assert.equal(describeSchedule({ schedule_type: 'once', rrule: null }), 'once')
  assert.equal(describeSchedule({ schedule_type: 'recurring', rrule: 'FREQ=HOURLY;INTERVAL=1' }), 'hourly')
  assert.equal(describeSchedule({ schedule_type: 'recurring', rrule: 'FREQ=HOURLY;INTERVAL=6' }), 'every 6h')
  assert.equal(describeSchedule({ schedule_type: 'recurring', rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0' }), 'daily 08:00')
  assert.equal(describeSchedule({ schedule_type: 'recurring', rrule: 'FREQ=WEEKLY' }), 'weekly')
})

test('listAutomations excludes soft-deleted rows and never leaks prompts by default', { skip }, async () => {
  const configDir = fixture()
  const result = await listAutomations({ configDir })
  assert.equal(result.available, true)
  assert.deepEqual(result.counts, { live: 3, softDeleted: 1, returned: 3 })
  assert.deepEqual(result.automations.map((entry) => entry.id).sort(), ['a-daily', 'a-hourly', 'a-once'])
  const hourly = result.automations.find((entry) => entry.id === 'a-hourly')
  assert.equal(hourly.live, true)
  assert.equal(hourly.softDeleted, false)
  assert.equal(hourly.schedule, 'hourly')
  assert.equal(hourly.model, 'custom-local:m')
  assert.deepEqual(hourly.cwds, ['E:\\Code\\demo'])
  assert.equal(hourly.running, true)
  assert.equal(hourly.lastError, 'boom')
  assert.equal(hourly.lastRunSuccess, false)
  assert.equal(hourly.lastRunFailureCode, 'automation-request-refused')
  assert.equal(hourly.prompt, undefined)
  assert.match(hourly.nextRunAt, /^\d{4}-\d\d-\d\dT/)
})

test('soft-deleted rows stay visibly marked rather than looking active', { skip }, async () => {
  const configDir = fixture()
  const result = await listAutomations({ configDir, includeDeleted: true })
  const zombie = result.automations.find((entry) => entry.id === 'a-deleted')
  assert.equal(zombie.status, 'ACTIVE')
  assert.equal(zombie.softDeleted, true)
  assert.equal(zombie.live, false)
  assert.equal(result.counts.returned, 4)
})

test('includePrompt returns a bounded preview plus the byte size', { skip }, async () => {
  const configDir = fixture()
  const result = await listAutomations({ configDir, includePrompt: true })
  const hourly = result.automations.find((entry) => entry.id === 'a-hourly')
  assert.equal(hourly.promptBytes, 5000)
  assert.equal(hourly.prompt.length, 2000)
})

test('getAutomationRuns resolves by name and reports failure codes', { skip }, async () => {
  const configDir = fixture()
  const result = await getAutomationRuns({ configDir, name: 'guard' })
  assert.equal(result.available, true)
  assert.equal(result.automation.id, 'a-hourly')
  assert.equal(result.runs.length, 3)
  assert.equal(result.runs[0].failureCode, 'automation-request-refused')
  assert.equal(result.runs[0].reasonCode, 'interrupted')
  assert.deepEqual(result.totals, {
    total: 3,
    succeeded: 1,
    failed: 2,
    lastAt: result.totals.lastAt,
    failureCodes: [
      { code: 'automation-rate-limited', count: 1 },
      { code: 'automation-request-refused', count: 1 },
    ],
  })
})

test('getAutomationRuns can return only failures and hides titles on request', { skip }, async () => {
  const configDir = fixture()
  const result = await getAutomationRuns({ configDir, automationId: 'a-hourly', failuresOnly: true, includeTitle: false })
  assert.equal(result.runs.length, 2)
  assert.ok(result.runs.every((entry) => entry.success === false))
  assert.ok(result.runs.every((entry) => entry.titlePreview === undefined))
})

test('getAutomationRuns reports an unknown selector instead of inventing one', { skip }, async () => {
  const configDir = fixture()
  const result = await getAutomationRuns({ configDir, automationId: 'nope' })
  assert.equal(result.available, false)
  assert.match(result.reason, /no automation matches/)
})

test('automationHealth summarizes outcomes and flags overdue tasks', { skip }, async () => {
  const configDir = fixture()
  const result = await automationHealth({ configDir })
  assert.equal(result.available, true)
  assert.equal(result.runs.total, 3)
  assert.equal(result.runs.succeeded, 1)
  assert.equal(result.runs.failed, 2)
  assert.equal(result.runs.successRate, 0.3333)
  assert.deepEqual(result.runs.failureCodes.map((entry) => entry.code).sort(), [
    'automation-rate-limited',
    'automation-request-refused',
  ])
  const zombieRow = result.perTask.find((entry) => entry.id === 'a-deleted')
  assert.equal(zombieRow.live, false)
  // a-deleted has a next_run ~25h in the past but is soft-deleted, so it must
  // never be reported as an overdue *live* task.
  assert.equal(result.overdue.length, 0)
})

test('a missing database is reported, not guessed', { skip }, async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'dwb-auto-empty-'))
  const result = await listAutomations({ configDir: emptyDir })
  assert.equal(result.available, false)
  assert.match(result.reason, /database not found/)
  const health = await automationHealth({ configDir: emptyDir })
  assert.equal(health.available, false)
})

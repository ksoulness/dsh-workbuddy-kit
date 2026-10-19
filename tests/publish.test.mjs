import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeCwd, publishSession, readPublishedLedger, resolveUserId, unpublishSession } from '../src/publish.mjs'

const sqlite = await import('node:sqlite').catch(() => null)
const skip = sqlite === null ? 'node:sqlite is unavailable in this runtime' : false

const USER = '11111111-1111-4111-8111-111111111111'
const SESSION = 'session-pub-1'

/**
 * Build a fixture: a WorkBuddy-style config dir with one CLI transcript, an app
 * database holding one desktop row, and a kit state dir.
 * @returns {{ configDir: string, stateDir: string, transcript: string }}
 */
function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), 'dwb-pub-config-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'dwb-pub-state-'))
  const dir = join(configDir, 'projects', 'e-Code-demo')
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, `${SESSION}.jsonl`)
  const rows = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<user_query>查一下演示</user_query>' }],
      sessionId: SESSION,
      cwd: 'e:\\Code\\demo',
    },
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '完成' }],
      providerData: { requestModelId: 'custom-local:m' },
      sessionId: SESSION,
    },
  ]
  writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

  const db = new sqlite.DatabaseSync(join(configDir, 'workbuddy.db'))
  db.exec(`
    create table sessions (
      id text primary key, cwd text not null, user_id text not null, title text, custom_title text,
      status text not null default 'Pending', created_at integer not null, updated_at integer not null,
      last_activity_at integer, deleted_at integer, is_playground integer not null default 0,
      source_mode text, is_background_automation integer, mode text, model text, expert_id text,
      expert_locale text, expert_runtime_identity text, expert_marketplace text, permission_mode text,
      use_sandbox_cli integer, project_id text, transport text, unread integer,
      conversation_origin text, visibility text, group_id text, group_title text,
      agent_dirty integer, agent_dirty_at integer, agent_last_synced integer, verified_at integer,
      plugin_context_json text, addon_selection text, session_settings text,
      last_user_prompt_expert_selection text, context_window integer, buddy_snapshot_id text,
      buddy_binding_json text, thought_level text
    );
    create table session_usage (session_id text primary key, used integer not null, size integer not null, updated_at integer not null, credit_json text);
  `)
  db.prepare(
    `insert into sessions (id, cwd, user_id, title, status, created_at, updated_at, transport, source_mode)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('desktop-1', 'E:/Code/demo', USER, '桌面会话', 'completed', Date.now(), Date.now(), 'local', 'craft')
  db.close()
  return { configDir, stateDir, transcript }
}

/**
 * @param {string} configDir
 * @param {string} id
 * @returns {any}
 */
function readRow(configDir, id) {
  const db = new sqlite.DatabaseSync(join(configDir, 'workbuddy.db'), { readOnly: true })
  const row = db.prepare('select * from sessions where id = ?').get(id)
  const usage = db.prepare('select * from session_usage where session_id = ?').get(id)
  db.close()
  return { row, usage }
}

test('normalizeCwd matches the app storage form', () => {
  assert.equal(normalizeCwd('e:\\Code\\demo'), 'E:/Code/demo')
  assert.equal(normalizeCwd('E:/Code/demo/'), 'E:/Code/demo')
  assert.equal(normalizeCwd('/home/x/demo'), '/home/x/demo')
})

test('resolveUserId prefers an existing session row', { skip }, async () => {
  const { configDir } = fixture()
  assert.equal(resolveUserId({ configDir, DatabaseSync: sqlite.DatabaseSync }), USER)
})

test('publishSession inserts the row the app list needs', { skip }, async () => {
  const { configDir, stateDir, transcript } = fixture()
  const result = await publishSession({ configDir, stateDir, sessionId: SESSION })
  assert.equal(result.published, true)
  assert.equal(result.row.transport, 'local')
  assert.equal(result.row.source_mode, 'craft')
  assert.equal(result.row.cwd, 'E:/Code/demo')
  assert.equal(result.row.user_id, USER)
  assert.equal(result.row.status, 'completed')
  assert.equal(result.row.title, '【DSH 派发】查一下演示')
  const { row, usage } = readRow(configDir, SESSION)
  assert.equal(row.id, SESSION)
  assert.ok(usage.size > 0)
  // transcript untouched
  assert.ok(readFileSync(transcript, 'utf8').includes('查一下演示'))
  assert.equal(readPublishedLedger(stateDir).length, 1)
})

test('publishing twice is a no-op success', { skip }, async () => {
  const { configDir, stateDir } = fixture()
  const first = await publishSession({ configDir, stateDir, sessionId: SESSION })
  assert.equal(first.published, true)
  const second = await publishSession({ configDir, stateDir, sessionId: SESSION })
  assert.deepEqual([second.published, second.alreadyIndexed], [true, true])
})

test('publishSession refuses unknown, traversal, and cwd-less sessions', { skip }, async () => {
  const { configDir, stateDir } = fixture()
  assert.equal((await publishSession({ configDir, stateDir, sessionId: 'nope' })).reason, 'session-not-found')
  assert.equal((await publishSession({ configDir, stateDir, sessionId: '../x' })).reason, 'invalid-session-id')
  const orphanDir = join(configDir, 'projects', 'e-Code-orphan')
  mkdirSync(orphanDir, { recursive: true })
  const orphan = join(orphanDir, 'session-orphan.jsonl')
  writeFileSync(orphan, `${JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] })}\n`, 'utf8')
  assert.equal((await publishSession({ configDir, stateDir, sessionId: 'session-orphan' })).reason, 'session-has-no-cwd')
})

test('unpublishSession removes only what it created and keeps the transcript', { skip }, async () => {
  const { configDir, stateDir, transcript } = fixture()
  await publishSession({ configDir, stateDir, sessionId: SESSION })
  const removed = await unpublishSession({ configDir, stateDir, sessionId: SESSION })
  assert.equal(removed.unpublished, true)
  assert.equal(removed.deletedRows, 1)
  assert.equal(removed.transcriptKept, true)
  assert.equal(readRow(configDir, SESSION).row, undefined)
  assert.ok(readFileSync(transcript, 'utf8').length > 0)
  // the desktop row is untouched
  assert.equal(readRow(configDir, 'desktop-1').row.id, 'desktop-1')
})

test('unpublishSession refuses rows this kit did not publish', { skip }, async () => {
  const { configDir, stateDir } = fixture()
  const refused = await unpublishSession({ configDir, stateDir, sessionId: 'desktop-1' })
  assert.deepEqual([refused.unpublished, refused.reason], [false, 'not-published-by-this-kit'])
  assert.equal(readRow(configDir, 'desktop-1').row.id, 'desktop-1')
})

test('publishSession resolves a runId to its session', { skip }, async () => {
  const { configDir, stateDir } = fixture()
  const runId = 'wb-test-run'
  mkdirSync(join(stateDir, 'runs'), { recursive: true })
  writeFileSync(
    join(stateDir, 'runs', `${runId}.json`),
    JSON.stringify({
      runId,
      sessionId: SESSION,
      projectSlug: 'e-Code-demo',
      model: 'custom-local:m',
      permissionMode: 'acceptEdits',
      promptPreview: '来自 run 的标题',
      createdAt: new Date().toISOString(),
      terminalAt: new Date().toISOString(),
    }),
    'utf8',
  )
  const result = await publishSession({ configDir, stateDir, runId })
  assert.equal(result.published, true)
  assert.equal(result.row.title, '【DSH 派发】来自 run 的标题')
  assert.equal(result.row.model, 'custom-local:m')
})

test('publishSession reports an unknown runId instead of guessing', { skip }, async () => {
  const { configDir, stateDir } = fixture()
  const result = await publishSession({ configDir, stateDir, runId: 'wb-nope' })
  assert.deepEqual([result.published, result.reason], [false, 'unknown-run-id'])
})

test('a run published on finish records the outcome on its journal', { skip }, async () => {
  const { configDir, stateDir } = fixture()
  const { finalizeRun, publishRunToApp } = await import('../src/runs.mjs')
  const runId = 'wb-publish-on-finish'
  const runDir = join(stateDir, 'runs')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, `${runId}.json`),
    JSON.stringify({
      runId,
      kind: 'run',
      state: 'running',
      sessionId: SESSION,
      projectSlug: 'e-Code-demo',
      workspace: 'E:/Code/demo',
      promptPreview: '查北京天气',
      model: 'custom-local:m',
      permissionMode: 'acceptEdits',
      publishToApp: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      assistantText: '',
      diagnostics: [],
    }),
    'utf8',
  )
  writeFileSync(
    join(runDir, `${runId}.stream.jsonl`),
    `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 5 })}\n`,
    'utf8',
  )
  const discovery = { configDir, found: true }
  const finalRun = finalizeRun({ stateDir, discovery, runId, exitCode: 0, signal: null })
  assert.equal(finalRun.state, 'succeeded')
  assert.equal(finalRun.publishToApp, true)
  const publishResult = await publishRunToApp({ stateDir, configDir, run: finalRun })
  assert.equal(publishResult.published, true)
  const journal = JSON.parse(readFileSync(join(runDir, `${runId}.json`), 'utf8'))
  assert.equal(journal.publishResult.published, true)
  assert.equal(readRow(configDir, SESSION).row.id, SESSION)
})

test('a failed publish never rewrites the run verdict', { skip }, async () => {
  const { configDir, stateDir } = fixture()
  const { publishRunToApp } = await import('../src/runs.mjs')
  const runDir = join(stateDir, 'runs')
  mkdirSync(runDir, { recursive: true })
  const run = { runId: 'wb-publish-fails', sessionId: 'missing-session', projectSlug: 'e-Code-demo', promptPreview: 'x', state: 'succeeded' }
  writeFileSync(join(runDir, `${run.runId}.json`), JSON.stringify(run), 'utf8')
  const result = await publishRunToApp({ stateDir, configDir, run })
  assert.deepEqual([result.published, result.reason], [false, 'session-not-found'])
  const journal = JSON.parse(readFileSync(join(runDir, `${run.runId}.json`), 'utf8'))
  assert.equal(journal.state, 'succeeded')
  assert.equal(journal.publishResult.published, false)
})

test('buildTitle keeps titles short and list-friendly', async () => {
  const { buildTitle } = await import('../src/publish.mjs')
  assert.equal(buildTitle('查北京天气', 'abcdef123'), '【DSH 派发】查北京天气')
  assert.equal(buildTitle('', 'abcdef123'), '【DSH 派发】abcdef12')
  assert.equal(buildTitle('【DSH 派发】已有前缀', 'abcdef123'), '【DSH 派发】已有前缀')
  const long = 'x'.repeat(200)
  const title = buildTitle(long, 'abcdef123')
  assert.ok(title.length <= 60, `title too long: ${title.length}`)
  assert.ok(title.endsWith('…'))
  assert.equal(buildTitle('第一行\n第二行', 'abcdef123'), '【DSH 派发】第一行')
})

test('getRun publishes a terminal run that never recorded a publish', { skip }, async () => {
  const { configDir, stateDir } = fixture()
  const { getRun } = await import('../src/runs.mjs')
  const runId = 'wb-reconciled-publish'
  const runDir = join(stateDir, 'runs')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, `${runId}.json`),
    JSON.stringify({
      runId,
      kind: 'run',
      state: 'succeeded',
      stateSource: 'transcript',
      stopReason: 'recovered-from-transcript',
      sessionId: SESSION,
      projectSlug: 'e-Code-demo',
      workspace: 'E:/Code/demo',
      promptPreview: '被 reconcile 发现的任务',
      publishToApp: true,
      assistantText: 'ok',
    }),
    'utf8',
  )
  const run = await getRun(runId, { stateDir, discovery: { configDir, found: true } })
  assert.equal(run.publishResult.published, true)
  assert.equal(readRow(configDir, SESSION).row.id, SESSION)
  const again = await getRun(runId, { stateDir, discovery: { configDir, found: true } })
  assert.equal(again.publishResult.published, true)
  assert.equal(readRow(configDir, SESSION).row.id, SESSION)
})

test('publishing defaults on and can be turned off explicitly', async () => {
  const { resolvePublishFlag } = await import('../src/publish.mjs')
  assert.equal(resolvePublishFlag(undefined), true)
  assert.equal(resolvePublishFlag(true), true)
  assert.equal(resolvePublishFlag(false), false)
})

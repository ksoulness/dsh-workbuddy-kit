import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { archiveSession, findSessionFile, listProjects, listSessions, readSession } from '../src/sessions.mjs'

/**
 * Build a fake WorkBuddy data directory with one finished session.
 * @param {{ ageMs?: number, completed?: boolean, sessionId?: string, project?: string }} [options]
 */
function fakeConfig(options = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'dwb-sessions-'))
  const project = options.project ?? 'e-Code-demo'
  const sessionId = options.sessionId ?? 'session-111'
  const dir = join(configDir, 'projects', project)
  mkdirSync(dir, { recursive: true })
  const entries = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'do the thing' }],
      sessionId,
      cwd: 'e:\\Code\\demo',
    },
    {
      type: 'message',
      role: 'assistant',
      status: options.completed === false ? 'running' : 'completed',
      content: [{ type: 'output_text', text: 'done: evidence' }],
      providerData: { requestModelId: 'custom-local:m' },
      sessionId,
    },
  ]
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
  return { configDir, project, sessionId, file }
}

test('listProjects and listSessions see the vendor session store', () => {
  const { configDir, project, sessionId } = fakeConfig()
  const projects = listProjects({ configDir })
  assert.equal(projects.length, 1)
  assert.equal(projects[0].slug, project)
  assert.equal(projects[0].sessionCount, 1)
  const sessions = listSessions({ configDir, limit: 5 })
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].sessionId, sessionId)
  assert.equal(sessions[0].hasResult, true)
  assert.equal(sessions[0].firstPrompt, 'do the thing')
})

test('listSessions filters by workspace-derived project slug', () => {
  const { configDir } = fakeConfig()
  assert.equal(listSessions({ configDir, cwd: 'E:\\Code\\demo' }).length, 1)
  assert.equal(listSessions({ configDir, cwd: 'E:\\Code\\other' }).length, 0)
})

test('findSessionFile refuses traversal-shaped ids', () => {
  const { configDir } = fakeConfig()
  assert.equal(findSessionFile({ configDir, sessionId: '../../etc/passwd' }), null)
  assert.ok(findSessionFile({ configDir, sessionId: 'session-111' }))
})

test('readSession returns the transcript with model evidence', () => {
  const { configDir, sessionId } = fakeConfig()
  const transcript = readSession({ configDir, sessionId })
  assert.equal(transcript.found, true)
  assert.equal(transcript.cwd, 'e:\\Code\\demo')
  assert.equal(transcript.entries.length, 2)
  assert.equal(transcript.entries[1].model, 'custom-local:m')
  assert.equal(transcript.entries[1].text, 'done: evidence')
})

test('archiveSession copies a terminal session and stamps it', () => {
  const { configDir, sessionId, project, file } = fakeConfig()
  const stateDir = mkdtempSync(join(tmpdir(), 'dwb-state-'))
  const result = archiveSession({
    configDir,
    stateDir,
    sessionId,
    project,
    completedSessionIds: [sessionId],
  })
  assert.equal(result.archived, true)
  assert.equal(result.mode, 'copy')
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.ok(result.targetPath.includes(join('session-archive')))
  assert.ok(result.manifestPath.endsWith('.manifest.json'))
  // copy mode must leave the vendor session in place
  assert.equal(findSessionFile({ configDir, sessionId }), file)
})

test('archiveSession refuses an active session', () => {
  const { configDir, sessionId, project } = fakeConfig()
  const stateDir = mkdtempSync(join(tmpdir(), 'dwb-state-'))
  const result = archiveSession({ configDir, stateDir, sessionId, project, activeSessionIds: [sessionId] })
  assert.deepEqual([result.archived, result.reason], [false, 'session-is-active'])
})

test('archiveSession refuses a fresh transcript without terminal evidence', () => {
  const { configDir, sessionId, project } = fakeConfig()
  const stateDir = mkdtempSync(join(tmpdir(), 'dwb-state-'))
  const result = archiveSession({ configDir, stateDir, sessionId, project })
  assert.deepEqual([result.archived, result.reason], [false, 'session-may-be-active'])
  const forced = archiveSession({ configDir, stateDir, sessionId, project, force: true })
  assert.equal(forced.archived, true)
})

test('archiveSession refuses sessions with no completion record', () => {
  const { configDir, sessionId, project } = fakeConfig({ completed: false })
  const stateDir = mkdtempSync(join(tmpdir(), 'dwb-state-'))
  const result = archiveSession({
    configDir,
    stateDir,
    sessionId,
    project,
    force: true,
  })
  assert.deepEqual([result.archived, result.reason], [false, 'session-not-terminal'])
})

test('archiveSession never overwrites an existing copy by accident', () => {
  const { configDir, sessionId, project } = fakeConfig()
  const stateDir = mkdtempSync(join(tmpdir(), 'dwb-state-'))
  const first = archiveSession({ configDir, stateDir, sessionId, project, completedSessionIds: [sessionId] })
  assert.equal(first.archived, true)
  const second = archiveSession({ configDir, stateDir, sessionId, project, completedSessionIds: [sessionId] })
  assert.deepEqual([second.archived, second.reason], [false, 'target-exists'])
  const third = archiveSession({ configDir, stateDir, sessionId, project, completedSessionIds: [sessionId], overwrite: true })
  assert.equal(third.archived, true)
})

test('archiveSession reports an unknown session instead of inventing one', () => {
  const { configDir } = fakeConfig()
  const stateDir = mkdtempSync(join(tmpdir(), 'dwb-state-'))
  const result = archiveSession({ configDir, stateDir, sessionId: 'session-missing' })
  assert.deepEqual([result.archived, result.reason], [false, 'session-not-found'])
})

test('move mode is opt-in and removes the vendor transcript', () => {
  const { configDir, sessionId, project, file } = fakeConfig()
  const stateDir = mkdtempSync(join(tmpdir(), 'dwb-state-'))
  const result = archiveSession({
    configDir,
    stateDir,
    sessionId,
    project,
    mode: 'move',
    completedSessionIds: [sessionId],
  })
  assert.equal(result.archived, true)
  assert.equal(findSessionFile({ configDir, sessionId }), null)
  assert.notEqual(result.targetPath, file)
})

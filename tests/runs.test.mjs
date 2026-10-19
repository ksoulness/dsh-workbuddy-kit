import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildInvocation, PERMISSION_MODES } from '../src/cli.mjs'
import { makeRunId, summarizeJournalStream, TERMINAL_STATES } from '../src/runs.mjs'

const discovery = {
  cliEntry: 'D:\\wb\\cli\\bin\\codebuddy',
  nodeBinary: 'C:\\wb\\node.exe',
  configDir: 'C:\\Users\\x\\.workbuddy',
  liteBundleOnly: true,
}

test('buildInvocation asks for streamed JSON and a bounded dispatch', () => {
  const invocation = buildInvocation({
    discovery,
    prompt: 'do it',
    workspace: 'E:\\Code\\demo',
    model: 'custom-local:m',
    permissionMode: 'plan',
    maxTurns: 3,
    sessionId: 'session-1',
    disallowedTools: ['Write'],
  })
  assert.equal(invocation.command, 'C:\\wb\\node.exe')
  assert.equal(invocation.args[0], discovery.cliEntry)
  const args = invocation.args.join(' ')
  assert.ok(args.includes('-p --output-format stream-json'))
  assert.ok(args.includes('--permission-mode plan'))
  assert.ok(args.includes('--model custom-local:m'))
  assert.ok(args.includes('--max-turns 3'))
  assert.ok(args.includes('--session-id session-1'))
  assert.ok(args.includes('--disallowedTools Write'))
  assert.equal(invocation.args.at(-1), 'do it')
  assert.equal(invocation.cwd, 'E:\\Code\\demo')
})

test('buildInvocation routes the CLI at the WorkBuddy data directory', () => {
  const invocation = buildInvocation({ discovery, prompt: 'p', workspace: 'E:\\Code\\demo' })
  assert.equal(invocation.env.CODEBUDDY_CONFIG_DIR, discovery.configDir)
  assert.equal(invocation.env.WORKBUDDY_CONFIG_DIR, discovery.configDir)
  assert.equal(invocation.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE, '1')
})

test('buildInvocation omits the lite flag for a full bundle install', () => {
  const invocation = buildInvocation({
    discovery: { ...discovery, liteBundleOnly: false },
    prompt: 'p',
    workspace: 'E:\\Code\\demo',
  })
  assert.equal(invocation.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE, undefined)
})

test('buildInvocation rejects bad input before spawning anything', () => {
  assert.throws(() => buildInvocation({ discovery, prompt: '   ', workspace: 'E:\\Code\\demo' }), /prompt/)
  assert.throws(
    () => buildInvocation({ discovery, prompt: 'p', workspace: 'E:\\Code\\demo', permissionMode: 'yolo' }),
    /permissionMode/,
  )
  assert.throws(
    () => buildInvocation({ discovery, prompt: 'p', workspace: 'E:\\Code\\demo', sessionId: '../escape' }),
    /sessionId/,
  )
  assert.deepEqual(PERMISSION_MODES.includes('plan'), true)
})

test('makeRunId is deterministic for an idempotency key', () => {
  assert.equal(makeRunId('task-a'), makeRunId('task-a'))
  assert.notEqual(makeRunId('task-a'), makeRunId('task-b'))
  assert.match(makeRunId('task-a'), /^wb-[a-f0-9]{16}$/)
  assert.match(makeRunId(undefined, () => Date.parse('2026-10-19T07:00:00Z')), /^wb-20261019T070000-/)
})

test('summarizeJournalStream recovers a verdict from the raw log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-stream-'))
  const file = join(dir, 'run.stream.jsonl')
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's-1', model: 'custom-local:m', tools: ['Read'] },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Read' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 5, session_id: 's-1' },
  ]
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  const summary = summarizeJournalStream(file)
  assert.equal(summary.sessionId, 's-1')
  assert.equal(summary.model, 'custom-local:m')
  assert.equal(summary.assistantText, 'hello')
  assert.equal(summary.toolUseCount, 1)
  assert.equal(summary.toolResults, 1)
  assert.equal(summary.result.isError, false)
  assert.equal(summary.durationMs, 5)
  assert.equal(summary.eventCount, 4)
})

test('summarizeJournalStream tolerates a missing log', () => {
  const summary = summarizeJournalStream(join(tmpdir(), 'definitely-missing-dwb.jsonl'))
  assert.equal(summary.result, null)
  assert.equal(summary.eventCount, 0)
})

test('terminal states are exactly the four terminal verdicts', () => {
  assert.deepEqual([...TERMINAL_STATES].sort(), ['cancelled', 'failed', 'succeeded', 'unknown'])
})

test('skipPermissions is opt-in and never implied', () => {
  const without = buildInvocation({ discovery, prompt: 'p', workspace: 'E:\\Code\\demo' })
  assert.equal(without.args.includes('-y'), false)
  const withFlag = buildInvocation({ discovery, prompt: 'p', workspace: 'E:\\Code\\demo', skipPermissions: true })
  assert.equal(withFlag.args.includes('-y'), true)
})

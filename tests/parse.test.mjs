import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createParser, flattenContent, readHeadTail, readSessionTranscript, summarizeSessionFile } from '../src/parse.mjs'

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'session-abc',
  model: 'custom-local:test-model',
  cwd: 'E:\\work',
  tools: ['Read', 'Grep', 'Bash'],
}

const ASSISTANT = {
  type: 'assistant',
  session_id: 'session-abc',
  message: {
    content: [
      { type: 'text', text: 'first finding' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.md' } },
    ],
  },
}

const TOOL_RESULT = {
  type: 'user',
  session_id: 'session-abc',
  message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file body' }] },
}

const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: 'session-abc',
  duration_ms: 1234,
  total_cost_usd: 0,
  usage: { input_tokens: 10, output_tokens: 2 },
}

test('flattenContent keeps text, counts tools, tolerates junk', () => {
  assert.deepEqual(flattenContent('plain'), { text: 'plain', toolUses: [], toolResults: 0 })
  assert.deepEqual(flattenContent(null), { text: '', toolUses: [], toolResults: 0 })
  const flattened = flattenContent([
    { type: 'text', text: 'a' },
    { type: 'output_text', text: 'b' },
    { type: 'tool_use', id: 'x', name: 'Read' },
    { type: 'tool_result' },
    { type: 'thinking', thinking: 'ignored' },
  ])
  assert.equal(flattened.text, 'a\nb')
  assert.deepEqual(flattened.toolUses, [{ id: 'x', name: 'Read' }])
  assert.equal(flattened.toolResults, 1)
})

test('parser decodes a full dispatch stream', () => {
  const parser = createParser()
  for (const event of [INIT, ASSISTANT, TOOL_RESULT, RESULT]) parser.push(JSON.stringify(event))
  const snapshot = parser.snapshot()
  assert.equal(snapshot.sessionId, 'session-abc')
  assert.equal(snapshot.model, 'custom-local:test-model')
  assert.equal(snapshot.cwd, 'E:\\work')
  assert.deepEqual(snapshot.tools, ['Read', 'Grep', 'Bash'])
  assert.equal(snapshot.assistantText, 'first finding')
  assert.equal(snapshot.toolUseCount, 1)
  assert.equal(snapshot.toolResults, 1)
  assert.equal(snapshot.result.subtype, 'success')
  assert.equal(snapshot.result.isError, false)
  assert.equal(snapshot.result.durationMs, 1234)
})

test('parser counts malformed lines instead of throwing', () => {
  const parser = createParser()
  parser.push('not json')
  parser.push('{"type":"result","subtype":"error_during_execution","is_error":true}')
  const snapshot = parser.snapshot()
  assert.equal(snapshot.parseErrors, 1)
  assert.equal(snapshot.result.isError, true)
})

test('parser keeps stderr diagnostics bounded and ordered', () => {
  const parser = createParser()
  parser.noteDiagnostic('  warn one  ')
  parser.noteDiagnostic('')
  parser.noteDiagnostic('warn two')
  assert.deepEqual(parser.snapshot().diagnostics, ['warn one', 'warn two'])
})

test('summarizeSessionFile reads the human prompt, not WorkBuddy preamble', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-parse-'))
  const file = join(dir, 'session-1.jsonl')
  const lines = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<system-reminder>noise</system-reminder><user_query>real ask</user_query>' }],
      sessionId: 'session-1',
      cwd: 'e:\\work',
    },
    { type: 'file-history-snapshot', timestamp: 1 },
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'answer body' }],
      providerData: { requestModelId: 'custom-local:m' },
      sessionId: 'session-1',
    },
  ]
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  const summary = summarizeSessionFile(file)
  assert.equal(summary.firstPrompt, 'real ask')
  assert.equal(summary.lastAssistantText, 'answer body')
  assert.equal(summary.hasResult, true)
  assert.equal(summary.model, 'custom-local:m')
  assert.equal(summary.sessionId, 'session-1')
})

test('readHeadTail truncates large transcripts but keeps both ends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-headtail-'))
  const file = join(dir, 'big.jsonl')
  const filler = 'x'.repeat(2048)
  const rows = ['HEAD']
  for (let index = 0; index < 400; index += 1) rows.push(filler)
  rows.push('TAIL')
  writeFileSync(file, `${rows.join('\n')}\n`, 'utf8')
  const { head, tail, truncated } = readHeadTail(file, { headBytes: 64, tailBytes: 64 })
  assert.equal(truncated, true)
  assert.ok(head.startsWith('HEAD'))
  assert.ok(tail.endsWith('TAIL\n') || tail.endsWith('TAIL'))
})

test('readSessionTranscript keeps CLI tool traffic (function_call entries)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwb-fncalls-'))
  const file = join(dir, 'session-2.jsonl')
  const rows = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_query>查天气</user_query>' }], sessionId: 's-2', cwd: 'e:\\w' },
    { type: 'file-history-snapshot', timestamp: 1, messageId: 'm1' },
    { type: 'function_call', callId: 'c1', name: 'Bash', arguments: { command: 'curl -s https://example.test/a' } },
    { type: 'function_call_result', callId: 'c1', name: 'Bash', status: 'completed', output: 'Stdout: {"temperature_2m":17.2}' },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '17.2 °C' }], sessionId: 's-2' },
  ]
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  const transcript = readSessionTranscript(file, { readFile: (path) => readFileSync(path, 'utf8') })
  assert.deepEqual(transcript.entries.map((entry) => entry.kind), ['message', 'file-history-snapshot', 'tool-call', 'tool-result', 'message'])
  const call = transcript.entries[2]
  assert.equal(call.name, 'Bash')
  assert.equal(call.callId, 'c1')
  assert.match(call.arguments, /curl -s/)
  const result = transcript.entries[3]
  assert.equal(result.status, 'completed')
  assert.match(result.output, /17\.2/)
  assert.equal(transcript.entries[4].text, '17.2 °C')
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { handleRequest } from '../mcp/server.mjs'
import { tools } from '../src/tools.mjs'

/** Keywords the Harness tool schema subset accepts. */
const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

/**
 * Walk a schema and report unsupported keywords.
 * @param {any} node
 * @param {string} path
 * @param {string[]} out
 */
function collectUnsupported(node, path, out) {
  if (node === null || typeof node !== 'object') return
  for (const key of Object.keys(node)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) out.push(`${path}.${key}`)
  }
  for (const [key, value] of Object.entries(node.properties ?? {})) collectUnsupported(value, `${path}.properties.${key}`, out)
  if (node.items) collectUnsupported(node.items, `${path}.items`, out)
  for (const [index, entry] of (node.oneOf ?? []).entries()) collectUnsupported(entry, `${path}.oneOf[${index}]`, out)
}

test('every tool name is namespaced and unique', () => {
  const names = tools.map((entry) => entry.name)
  assert.equal(new Set(names).size, names.length)
  for (const name of names) assert.match(name, /^wb_[a-z_]+$/)
  assert.ok(names.includes('wb_start_run') && names.includes('wb_wait_run') && names.includes('wb_archive_session'))
})

test('every schema stays inside the Harness tool-schema subset', () => {
  const violations = []
  for (const entry of tools) {
    assert.equal(entry.parameters.type, 'object', `${entry.name} parameters must be object-rooted`)
    assert.equal(typeof entry.description, 'string')
    collectUnsupported(entry.parameters, `${entry.name}.parameters`, violations)
    collectUnsupported(entry.output.schema, `${entry.name}.output`, violations)
    assert.equal(typeof entry.output.render, 'function')
  }
  assert.deepEqual(violations, [])
})

test('handleRequest speaks initialize, tools/list and unknown methods', async () => {
  const context = { env: process.env }
  const init = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, context)
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(init.result.serverInfo.name, 'dsh-workbuddy-kit')
  assert.ok(init.result.capabilities.tools)

  const list = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, context)
  assert.equal(list.result.tools.length, tools.length)
  assert.ok(list.result.tools.every((entry) => entry.inputSchema.type === 'object'))

  const missing = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'nope/nope' }, context)
  assert.equal(missing.error.code, -32601)

  const notification = await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, context)
  assert.equal(notification, null)
})

test('tools/call returns structured text and never throws through the protocol', async () => {
  const good = await handleRequest(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'wb_list_runs', arguments: { limit: 1 } } },
    { env: process.env, stateDir: mkdtempSync(join(tmpdir(), 'dwb-mcp-')) },
  )
  assert.equal(good.result.isError, false)
  assert.ok(JSON.parse(good.result.content[0].text).runs)

  const unknown = await handleRequest(
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'wb_nope', arguments: {} } },
    { env: process.env },
  )
  assert.equal(unknown.error.code, -32602)

  const thrown = await handleRequest(
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'wb_get_run', arguments: { runId: 'wb-does-not-exist' } } },
    { env: process.env },
  )
  assert.equal(thrown.result.isError, true)
  assert.match(JSON.parse(thrown.result.content[0].text).error, /unknown runId/)
})

test('stdio server answers a real handshake and keeps stdout clean', async () => {
  const server = spawn(process.execPath, [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))], {
    env: { ...process.env, DWB_STATE_DIR: mkdtempSync(join(tmpdir(), 'dwb-mcp-stdio-')) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: server.stdout })
  /** @type {any[]} */
  const responses = []
  const received = new Promise((resolve) => {
    lines.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        responses.push({ parseError: line })
        return
      }
      responses.push(message)
      if (message.id === 2) resolve(undefined)
    })
  })
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
  await received
  server.stdin.end()
  await new Promise((resolve) => server.on('close', resolve))

  assert.equal(responses.length, 2)
  assert.ok(responses.every((message) => message.parseError === undefined))
  assert.equal(responses[0].result.serverInfo.name, 'dsh-workbuddy-kit')
  assert.equal(responses[1].result.tools.length, tools.length)
})

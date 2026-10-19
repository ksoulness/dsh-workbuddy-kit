#!/usr/bin/env node
/**
 * stdio MCP server front door.
 *
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout, no dependencies. Advertises
 * only `tools`; every tool is the same descriptor the native DSH plugin
 * registers, so both front doors stay in lockstep.
 *
 * The server writes nothing to stdout except protocol messages: diagnostics go
 * to stderr so a client's parser can never be corrupted.
 *
 * @module dsh-workbuddy-kit/mcp/server
 */

import { readFileSync, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { tools, toolNames } from '../src/tools.mjs'

/** MCP protocol revisions this server can speak (newest first). */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/** Version reported at initialize, read from the manifest so a bump cannot drift. */
const SERVER_VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const SERVER_INFO = { name: 'dsh-workbuddy-kit', version: SERVER_VERSION }

/**
 * Serialize one JSON-RPC message.
 * @param {object} message
 * @returns {string}
 */
function encode(message) {
  return `${JSON.stringify(message)}\n`
}

/**
 * @param {NodeJS.WritableStream} stream
 * @param {object} message
 */
function send(stream, message) {
  stream.write(encode(message))
}

/**
 * @param {any} id
 * @param {any} result
 * @returns {object}
 */
function result(id, value) {
  return { jsonrpc: '2.0', id, result: value }
}

/**
 * @param {any} id
 * @param {number} code
 * @param {string} message
 * @param {any} [data]
 * @returns {object}
 */
function error(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

/**
 * Handle one request object.
 * @param {any} request
 * @param {{ env: NodeJS.ProcessEnv }} context
 * @returns {Promise<object | null>} the response, or null for notifications
 */
export async function handleRequest(request, context) {
  if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
    return error(request?.id ?? null, -32600, 'invalid request')
  }
  const isNotification = request.id === undefined || request.id === null
  const { method } = request
  const params = request.params ?? {}

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSIONS[0]
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]
    return result(request.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'WorkBuddy delegation tools. Dispatch with wb_start_review (read-only) or wb_start_run, wait with wb_wait_run until terminal, verify with wb_read_session, then archive exactly that session with wb_archive_session.',
    })
  }
  if (isNotification) return null

  switch (method) {
    case 'ping':
      return result(request.id, {})
    case 'tools/list':
      return result(request.id, {
        tools: tools.map((entry) => ({
          name: entry.name,
          description: entry.description,
          inputSchema: entry.parameters,
        })),
      })
    case 'tools/call': {
      const name = params.name
      const entry = tools.find((candidate) => candidate.name === name)
      if (!entry) return error(request.id, -32602, `unknown tool: ${String(name)}`, { available: toolNames() })
      try {
        const value = await entry.handler(params.arguments ?? {}, context)
        return result(request.id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          isError: false,
        })
      } catch (failure) {
        const message = String(failure?.message ?? failure)
        return result(request.id, {
          content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
          isError: true,
        })
      }
    }
    case 'resources/list':
      return result(request.id, { resources: [] })
    case 'prompts/list':
      return result(request.id, { prompts: [] })
    default:
      return error(request.id, -32601, `method not found: ${method}`)
  }
}

/**
 * Serve MCP over the given streams.
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<void>}
 */
export function serve(options = {}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const context = { env: options.env ?? process.env, cwd: options.cwd ?? process.cwd() }
  const lines = createInterface({ input, crlfDelay: Infinity })
  return new Promise((resolve) => {
    let queue = Promise.resolve()
    lines.on('line', (line) => {
      const trimmed = line.trim()
      if (trimmed === '') return
      let request
      try {
        request = JSON.parse(trimmed)
      } catch {
        send(output, error(null, -32700, 'parse error'))
        return
      }
      queue = queue
        .then(async () => {
          const response = await handleRequest(request, context)
          if (response) send(output, response)
        })
        .catch((failure) => {
          send(output, error(request?.id ?? null, -32603, String(failure?.message ?? failure)))
        })
    })
    lines.on('close', () => {
      queue.finally(() => resolve())
    })
    process.stderr.write(`[dsh-workbuddy-kit] MCP server ready with ${tools.length} tools\n`)
  })
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const argvPath = realpathSync(entry)
    return self === argvPath
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  serve().catch((failure) => {
    process.stderr.write(`[dsh-workbuddy-kit] fatal: ${String(failure?.stack ?? failure)}\n`)
    process.exitCode = 1
  })
}

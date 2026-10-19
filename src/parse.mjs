/**
 * Decode the CLI's `--output-format stream-json` stream and WorkBuddy session
 * transcripts.
 *
 * Two shapes are handled here because they come from the same producer:
 *   1. the live stream (`type: system|assistant|user|result|stream_event`), and
 *   2. the on-disk session file (`<configDir>/projects/<slug>/<sessionId>.jsonl`).
 *
 * @module dsh-workbuddy-kit/src/parse
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

/** Bound applied to any single captured text so one run cannot exhaust memory. */
export const MAX_TEXT_CHARS = 200_000

/**
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
function bound(text, limit = MAX_TEXT_CHARS) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`
}

/**
 * Flatten a content-block array into readable text plus tool call records.
 * @param {any} content
 * @returns {{ text: string, toolUses: Array<{ id?: string, name: string }>, toolResults: number }}
 */
export function flattenContent(content) {
  if (typeof content === 'string') return { text: content, toolUses: [], toolResults: 0 }
  if (!Array.isArray(content)) return { text: '', toolUses: [], toolResults: 0 }
  const texts = []
  const toolUses = []
  let toolResults = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' || block.type === 'output_text' || block.type === 'input_text') {
      if (typeof block.text === 'string') texts.push(block.text)
      continue
    }
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      toolUses.push({ ...(typeof block.id === 'string' ? { id: block.id } : {}), name: String(block.name ?? 'unknown') })
      continue
    }
    if (block.type === 'tool_result') toolResults += 1
  }
  return { text: texts.join('\n'), toolUses, toolResults }
}

/**
 * Incremental decoder for the live `stream-json` channel.
 * @param {{ onEvent?: (event: object) => void }} [options]
 */
export function createParser(options = {}) {
  const onEvent = options.onEvent
  /** @type {any} */
  const state = {
    sessionId: null,
    model: null,
    cwd: null,
    permissionMode: null,
    tools: [],
    assistantText: '',
    toolUses: [],
    toolResults: 0,
    result: null,
    diagnostics: [],
    parseErrors: 0,
    eventCount: 0,
    assistantTurns: 0,
  }
  return {
    /**
     * Feed one JSONL line.
     * @param {string} line
     */
    push(line) {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        state.parseErrors += 1
        return
      }
      if (!event || typeof event !== 'object') return
      state.eventCount += 1
      if (typeof event.session_id === 'string' && state.sessionId === null) state.sessionId = event.session_id
      switch (event.type) {
        case 'system': {
          const subtype = event.subtype ?? ''
          if (subtype === 'init') {
            state.sessionId = typeof event.session_id === 'string' ? event.session_id : state.sessionId
            state.model = typeof event.model === 'string' ? event.model : state.model
            state.cwd = typeof event.cwd === 'string' ? event.cwd : state.cwd
            state.permissionMode = typeof event.permissionMode === 'string' ? event.permissionMode : state.permissionMode
            state.tools = Array.isArray(event.tools) ? event.tools.filter((name) => typeof name === 'string') : state.tools
          }
          if (subtype === 'diagnostic' && typeof event.message === 'string') state.diagnostics.push(event.message)
          break
        }
        case 'assistant': {
          state.assistantTurns += 1
          const flat = flattenContent(event.message?.content ?? event.content)
          if (flat.text !== '') {
            state.assistantText = state.assistantText === '' ? flat.text : `${state.assistantText}\n\n${flat.text}`
          }
          state.toolUses.push(...flat.toolUses)
          break
        }
        case 'user': {
          const flat = flattenContent(event.message?.content ?? event.content)
          state.toolResults += flat.toolResults
          break
        }
        case 'result': {
          state.result = {
            subtype: typeof event.subtype === 'string' ? event.subtype : 'unknown',
            isError: event.is_error === true,
            text: typeof event.result === 'string' ? event.result : '',
            usage: event.usage ?? null,
            durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
            costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
            sessionId: typeof event.session_id === 'string' ? event.session_id : null,
          }
          if (state.result.sessionId) state.sessionId = state.result.sessionId
          break
        }
        default:
          break
      }
      onEvent?.(event)
    },
    /**
     * Record a stderr or otherwise non-JSON diagnostic line.
     * @param {string} line
     */
    noteDiagnostic(line) {
      const trimmed = String(line).trim()
      if (trimmed !== '' && state.diagnostics.length < 200) state.diagnostics.push(trimmed)
    },
    /**
     * Current decoded state (bounded text included).
     * @returns {any}
     */
    snapshot() {
      return {
        ...state,
        assistantText: bound(state.assistantText),
        toolUseCount: state.toolUses.length,
      }
    },
  }
}

/**
 * Read the head and tail of a file without loading multi-megabyte transcripts.
 * @param {string} file
 * @param {{ headBytes?: number, tailBytes?: number }} [options]
 * @returns {{ head: string, tail: string, truncated: boolean }}
 */
export function readHeadTail(file, options = {}) {
  const headBytes = options.headBytes ?? 256 * 1024
  const tailBytes = options.tailBytes ?? 1024 * 1024
  const stat = statSync(file)
  if (stat.size <= headBytes + tailBytes) {
    const text = readFileSync(file, 'utf8')
    return { head: text, tail: text, truncated: false }
  }
  const fd = openSync(file, 'r')
  try {
    const headBuffer = Buffer.alloc(headBytes)
    readSync(fd, headBuffer, 0, headBytes, 0)
    const tailBuffer = Buffer.alloc(tailBytes)
    readSync(fd, tailBuffer, 0, tailBytes, stat.size - tailBytes)
    return { head: headBuffer.toString('utf8'), tail: tailBuffer.toString('utf8'), truncated: true }
  } finally {
    closeSync(fd)
  }
}

/**
 * Summarize a session transcript from its head and tail only.
 * @param {string} file
 * @param {{ readHeadTail?: (path: string) => { head: string, tail: string, truncated: boolean } }} [io]
 * @returns {{ firstPrompt: string, lastAssistantText: string, hasResult: boolean, model: string | null, cwd: string | null, turns: number, sessionId: string | null }}
 */
export function summarizeSessionFile(file, io = {}) {
  const reader = io.readHeadTail ?? ((path) => readHeadTail(path))
  const { head, tail } = reader(file)
  const headLines = head.split(/\r?\n/).filter((line) => line.trim() !== '')
  const tailLines = tail.split(/\r?\n/).filter((line) => line.trim() !== '')
  let firstPrompt = ''
  let cwd = null
  let sessionId = null
  for (const line of headLines.slice(0, 40)) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.sessionId === 'string' && sessionId === null) sessionId = entry.sessionId
    if (typeof entry.cwd === 'string' && cwd === null) cwd = entry.cwd
    if (entry.type === 'message' && entry.role === 'user' && firstPrompt === '') {
      // The first user message carries WorkBuddy's own context preamble; the
      // human prompt is the last <user_query> block when one exists.
      const flat = flattenContent(entry.content).text
      const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(flat)
      firstPrompt = (query ? query[1] : flat).trim().slice(0, 2000)
    }
  }
  let lastAssistantText = ''
  let hasResult = false
  let model = null
  let turns = 0
  for (const line of tailLines.slice(-400)) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    if (entry.type === 'message' && entry.role === 'assistant') {
      turns += 1
      const flat = flattenContent(entry.content)
      if (flat.text !== '') lastAssistantText = flat.text.slice(0, 4000)
      if (model === null && typeof entry.providerData?.requestModelId === 'string') model = entry.providerData.requestModelId
      if (entry.status === 'completed') hasResult = true
    }
    if (entry.type === 'result') hasResult = true
    if (typeof entry.sessionId === 'string' && sessionId === null) sessionId = entry.sessionId
  }
  return { firstPrompt, lastAssistantText, hasResult, model, cwd, turns, sessionId }
}

/**
 * Full structured read of a session transcript, bounded per entry.
 * @param {string} file
 * @param {{ readFile: (path: string) => string }} io
 * @returns {{ sessionId: string | null, cwd: string | null, entries: Array<object>, truncated: boolean }}
 */
export function readSessionTranscript(file, io) {
  const text = io.readFile(file)
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const entries = []
  let sessionId = null
  let cwd = null
  let truncated = false
  let totalBytes = 0
  for (const line of lines) {
    totalBytes += line.length
    if (entries.length >= 600 || totalBytes > 8_000_000) {
      truncated = true
      break
    }
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.sessionId === 'string' && sessionId === null) sessionId = entry.sessionId
    if (typeof entry.cwd === 'string' && cwd === null) cwd = entry.cwd
    const kind = entry.type
    if (kind === 'message') {
      const role = entry.role ?? 'unknown'
      const flat = flattenContent(entry.content)
      entries.push({
        kind: 'message',
        role,
        text: bound(flat.text, 20_000),
        toolUses: flat.toolUses,
        toolResults: flat.toolResults,
        timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : null,
        model: entry.providerData?.requestModelId ?? null,
      })
      continue
    }
    entries.push({ kind: typeof kind === 'string' ? kind : 'unknown', timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : null })
  }
  return { sessionId, cwd, entries, truncated }
}

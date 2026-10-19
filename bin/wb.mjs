#!/usr/bin/env node
/**
 * Human-facing CLI for dsh-workbuddy-kit.
 *
 * The DSH plugin and the MCP server are the machine front doors; this is the
 * one you can run by hand to prove the same code path works before wiring a
 * client. Every command prints JSON to stdout and exits non-zero only when the
 * command itself failed (a WorkBuddy run failing is data, not a CLI error).
 *
 * Usage: dwb <command> [--flag value ...]
 *
 * @module dsh-workbuddy-kit/bin/wb
 */

import { tools } from '../src/tools.mjs'

const argv = process.argv.slice(2)
const command = argv[0]

/**
 * Parse `--flag value` and `--flag` pairs into an object.
 * @param {string[]} tokens
 * @returns {Record<string, string | boolean>}
 */
function parseFlags(tokens) {
  const flags = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = tokens[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
      continue
    }
    flags[key] = next
    index += 1
  }
  return flags
}

/**
 * Invoke a tool by name with argument mapping.
 * @param {string} name
 * @param {Record<string, any>} args
 * @returns {Promise<any>}
 */
async function call(name, args) {
  const entry = tools.find((candidate) => candidate.name === name)
  if (!entry) throw new Error(`unknown tool: ${name}`)
  return entry.handler(args, { env: process.env })
}

const HELP = `dsh-workbuddy-kit CLI

  dwb doctor                          read-only self-check
  dwb capabilities                    permission modes and models
  dwb projects                        WorkBuddy project directories
  dwb sessions [--project P] [--workspace DIR] [--limit N]
  dwb session --id ID [--project P]
  dwb review --workspace DIR --task TEXT [--wait SECONDS] [--archive]
  dwb run    --workspace DIR --task TEXT [--wait SECONDS] [--archive]
  dwb wait --run RUNID [--timeout-ms N]
  dwb get --run RUNID
  dwb cancel --run RUNID
  dwb list [--limit N]
  dwb archive --session ID [--project P] [--mode copy|move] [--force]

Environment:
  DWB_CONFIG_DIR   WorkBuddy data directory (default: ~/.workbuddy)
  DWB_CLI_DIR      WorkBuddy bundled CLI directory (default: auto-detected)
  DWB_STATE_DIR    this kit's journal directory (default: ~/.dsh-workbuddy)
`

/**
 * Dispatch, optionally wait, optionally archive.
 * @param {'wb_start_review' | 'wb_start_run'} toolName
 * @param {Record<string, string | boolean>} flags
 */
async function dispatch(toolName, flags) {
  if (typeof flags.workspace !== 'string') throw new Error('--workspace is required')
  if (typeof flags.task !== 'string') throw new Error('--task is required')
  const started = await call(toolName, {
    workspace: flags.workspace,
    task: flags.task,
    ...(typeof flags.model === 'string' ? { model: flags.model } : {}),
    ...(typeof flags['max-turns'] === 'string' ? { maxTurns: Number(flags['max-turns']) } : {}),
  })
  print({ started })
  let run = started
  if (typeof flags.wait === 'string' || flags.wait === true) {
    const timeoutMs = (Number(flags.wait === true ? 600 : flags.wait) || 600) * 1000
    run = await call('wb_wait_run', { runId: started.runId, timeoutMs })
    print({ final: run })
  }
  if (flags.archive === true && run.sessionId) {
    const archived = await call('wb_archive_session', { sessionId: run.sessionId, project: run.projectSlug })
    print({ archived })
  }
  return run
}

/**
 * @param {any} value
 */
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

try {
  switch (command) {
    case 'doctor':
      print(await call('wb_doctor', {}))
      break
    case 'capabilities':
      print(await call('wb_list_capabilities', {}))
      break
    case 'projects':
      print(await call('wb_list_projects', {}))
      break
    case 'sessions': {
      const flags = parseFlags(argv.slice(1))
      print(
        await call('wb_list_sessions', {
          ...(typeof flags.project === 'string' ? { project: flags.project } : {}),
          ...(typeof flags.workspace === 'string' ? { workspace: flags.workspace } : {}),
          ...(typeof flags.limit === 'string' ? { limit: Number(flags.limit) } : {}),
        }),
      )
      break
    }
    case 'session': {
      const flags = parseFlags(argv.slice(1))
      if (typeof flags.id !== 'string') throw new Error('--id is required')
      print(
        await call('wb_read_session', {
          sessionId: flags.id,
          ...(typeof flags.project === 'string' ? { project: flags.project } : {}),
          ...(typeof flags.limit === 'string' ? { limit: Number(flags.limit) } : {}),
        }),
      )
      break
    }
    case 'review':
      await dispatch('wb_start_review', parseFlags(argv.slice(1)))
      break
    case 'run':
      await dispatch('wb_start_run', parseFlags(argv.slice(1)))
      break
    case 'wait': {
      const flags = parseFlags(argv.slice(1))
      if (typeof flags.run !== 'string') throw new Error('--run is required')
      print(await call('wb_wait_run', { runId: flags.run, ...(typeof flags['timeout-ms'] === 'string' ? { timeoutMs: Number(flags['timeout-ms']) } : {}) }))
      break
    }
    case 'get': {
      const flags = parseFlags(argv.slice(1))
      if (typeof flags.run !== 'string') throw new Error('--run is required')
      print(await call('wb_get_run', { runId: flags.run }))
      break
    }
    case 'cancel': {
      const flags = parseFlags(argv.slice(1))
      if (typeof flags.run !== 'string') throw new Error('--run is required')
      print(await call('wb_cancel_run', { runId: flags.run }))
      break
    }
    case 'list': {
      const flags = parseFlags(argv.slice(1))
      print(await call('wb_list_runs', typeof flags.limit === 'string' ? { limit: Number(flags.limit) } : {}))
      break
    }
    case 'archive': {
      const flags = parseFlags(argv.slice(1))
      if (typeof flags.session !== 'string') throw new Error('--session is required')
      print(
        await call('wb_archive_session', {
          sessionId: flags.session,
          ...(typeof flags.project === 'string' ? { project: flags.project } : {}),
          ...(typeof flags.mode === 'string' ? { mode: flags.mode } : {}),
          ...(flags.force === true ? { force: true } : {}),
        }),
      )
      break
    }
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(HELP)
      break
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`)
      process.exitCode = 2
  }
} catch (failure) {
  process.stderr.write(`${String(failure?.message ?? failure)}\n`)
  process.exitCode = 1
}

#!/usr/bin/env node
/**
 * Verify the plugin against the real `@deepseek-ai/dsh-tools` registry contract.
 *
 * The native front door must satisfy exactly what `ctx.tools.register()` checks
 * at runtime: a canonical `output { schema, render }`, a supported-schema-subset
 * `parameters` object, a valid `output.schema`, a unique non-reserved name, and
 * a working execution function. This script imports the DSH-bundled
 * `dsh-tools` (so the checks are the vendor's own, not a local copy) and runs
 * the registration through a stub context.
 *
 * Usage:
 *   node scripts/verify-registration.mjs [path-to-dsh-tools]
 *
 * Exit code 0 means every tool would register; 1 means at least one would fail.
 *
 * @module dsh-workbuddy-kit/scripts/verify-registration
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Candidate locations of the DSH-bundled `dsh-tools` package.
 * @returns {string[]}
 */
function candidates() {
  const list = []
  if (process.argv[2]) list.push(process.argv[2])
  const npmRoot = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules') : ''
  if (npmRoot) list.push(join(npmRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  if (process.env.DSH_HOME) {
    list.push(join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  }
  return list
}

/**
 * Resolve the dsh-tools entry that this host actually uses.
 * @returns {string}
 */
function resolveDshTools() {
  for (const candidate of candidates()) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error(`dsh-tools not found; pass its lib/index.js path explicitly`)
}

const entry = resolveDshTools()
const dshTools = await import(pathToFileURL(entry).href)
const { assertSupportedJsonSchema, assertObjectJsonSchema } = dshTools
if (typeof assertSupportedJsonSchema !== 'function') {
  process.stderr.write(`[verify] ${entry} does not export assertSupportedJsonSchema; cannot verify\n`)
  process.exit(1)
}

const plugin = await import(pathToFileURL(join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'plugin', 'index.mjs')).href)

/** Minimal stand-in for the parts of `ctx.tools` a plugin may touch. */
const registered = new Map()
const ctx = {
  tools: {
    /**
     * Mirror the vendor's registration assertions.
     * @param {any} definition
     */
    register(definition) {
      const name = definition?.name
      if (typeof name !== 'string' || name === '') throw new TypeError('tool name is required')
      if (registered.has(name)) throw new Error(`tool "${name}" registered twice`)
      if (name === 'run_code') throw new Error('run_code is reserved')
      const output = definition.output
      if (!output || typeof output !== 'object' || typeof output.render !== 'function') {
        throw new TypeError(`tool "${name}" must declare output { schema, render }`)
      }
      assertObjectJsonSchema(definition.parameters)
      assertSupportedJsonSchema(output.schema)
      if (typeof definition.execute !== 'function') throw new TypeError(`tool "${name}" must declare execute()`)
      registered.set(name, definition)
      return () => registered.delete(name)
    },
  },
}

plugin.apply(ctx, {})

const failures = []
for (const [name, definition] of registered) {
  try {
    const rendered = definition.output.render({}, { probe: true })
    if (!Array.isArray(rendered) || rendered[0]?.type !== 'text') failures.push(`${name}: render() must return text blocks`)
  } catch (error) {
    failures.push(`${name}: render() threw ${error?.message ?? error}`)
  }
  if (!/^wb_/.test(name)) failures.push(`${name}: expected a wb_ prefix`)
}

const expected = plugin.tools.length
process.stdout.write(
  `${JSON.stringify(
    {
      dshTools: entry,
      expectedTools: expected,
      registeredTools: registered.size,
      names: [...registered.keys()],
      failures,
    },
    null,
    2,
  )}\n`,
)

if (failures.length > 0 || registered.size !== expected) {
  process.stderr.write('[verify] plugin registration contract FAILED\n')
  process.exit(1)
}
process.stdout.write('[verify] plugin registration contract OK\n')

// ensure the module graph stays honest when run through a bundler-like loader
void createRequire

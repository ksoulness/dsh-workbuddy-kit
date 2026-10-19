/**
 * Native DSH plugin front door.
 *
 * Cordis loads this module as a plugin row; `apply` registers each tool from
 * the shared table on `ctx.tools`. No process starts and no WorkBuddy state is
 * touched until a tool is actually called.
 *
 * @module dsh-workbuddy-kit
 */

import { tools } from '../src/tools.mjs'

/** Cordis plugin name (must match the bundle row). */
export const name = 'dsh-workbuddy-kit'

/** Services this plugin needs before `apply` runs. */
export const inject = ['tools']

/**
 * Register the WorkBuddy tools for this composition.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ tools?: string[] }} [config] - optional allow-list of tool names.
 */
export function apply(ctx, config) {
  const allowed = Array.isArray(config?.tools) && config.tools.length > 0 ? new Set(config.tools) : null
  for (const entry of tools) {
    if (allowed && !allowed.has(entry.name)) continue
    ctx.tools.register({
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
      output: entry.output,
      execute: async (args) => entry.handler(args, { env: process.env }),
    })
  }
}

export { tools }

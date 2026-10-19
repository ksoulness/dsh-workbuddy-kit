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
 *
 * `workingDirectory` is optional: when the composition provides it, a dispatch
 * without an explicit `workspace` lands in the Session's own working directory,
 * so the desktop app groups the new conversation under the same workspace the
 * user already uses with DSH.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ tools?: string[] }} [config] - optional allow-list of tool names.
 */
export function apply(ctx, config) {
  const allowed = Array.isArray(config?.tools) && config.tools.length > 0 ? new Set(config.tools) : null
  const workingDirectory = ctx.get?.('workingDirectory')
  for (const entry of tools) {
    if (allowed && !allowed.has(entry.name)) continue
    ctx.tools.register({
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
      output: entry.output,
      execute: async (args, exec) => {
        let cwd
        if (workingDirectory?.ensure && exec?.agent !== undefined) {
          try {
            cwd = await workingDirectory.ensure(exec.agent, exec.signal)
          } catch {
            cwd = undefined
          }
        }
        return entry.handler(args, { env: process.env, cwd })
      },
    })
  }
}

export { tools }

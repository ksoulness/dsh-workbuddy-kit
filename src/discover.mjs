/**
 * Locate the local WorkBuddy installation and the agent CLI it ships.
 *
 * WorkBuddy (Tencent) bundles the CodeBuddy agent CLI inside its Electron
 * app: `<install>/resources/app.asar.unpacked/cli`. On this build only the
 * `lite-wb` bundle is shipped (`dist/codebuddy-lite-wb.mjs`), so the CLI must
 * be started with `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`; the launcher otherwise
 * tries to require `dist/codebuddy`, which does not exist here.
 *
 * Everything in this module is read-only.
 *
 * @module dsh-workbuddy-kit/src/discover
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Env vars WorkBuddy/CodeBuddy use to relocate their data directory. */
const CONFIG_DIR_ENV = ['DWB_CONFIG_DIR', 'WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR']

/** Env var that pins the CLI directory (escape hatch for odd installs). */
const CLI_DIR_ENV = 'DWB_CLI_DIR'

/** Relative path from an install root to the bundled CLI. */
const CLI_RELATIVE = ['resources', 'app.asar.unpacked', 'cli']

/**
 * The WorkBuddy data directory (`dataFolderName: ".workbuddy"` in the app's
 * product manifest).
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [options]
 * @returns {string} absolute directory that holds settings, projects, sessions
 */
export function resolveConfigDir(options = {}) {
  const env = options.env ?? process.env
  for (const key of CONFIG_DIR_ENV) {
    const value = env[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir()
  return join(home, '.workbuddy')
}

/**
 * Candidate WorkBuddy install roots, most specific first.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [options]
 * @returns {string[]}
 */
export function installCandidates(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? ''
    const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]
      .filter((value) => typeof value === 'string' && value !== '')
    return [
      env.ProgramFiles ? join(env.ProgramFiles, 'WorkBuddy') : '',
      'D:\\Program Files\\WorkBuddy',
      ...programFiles.map((root) => join(root, 'WorkBuddy')),
      local ? join(local, 'Programs', 'WorkBuddy') : '',
      'C:\\Program Files\\WorkBuddy',
    ].filter((value) => value !== '')
  }
  if (platform === 'darwin') {
    return [
      '/Applications/WorkBuddy.app/Contents',
      join(homedir(), 'Applications', 'WorkBuddy.app', 'Contents'),
    ]
  }
  return ['/opt/WorkBuddy/resources/../', '/opt/WorkBuddy', '/usr/lib/workbuddy']
}

/**
 * Resolve the CLI directory that contains `bin/codebuddy` and `dist/`.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, exists?: (path: string) => boolean }} [options]
 * @returns {{ cliDir: string, installRoot: string, cliEntry: string } | null}
 */
export function resolveCliDir(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const pinned = env[CLI_DIR_ENV]?.trim()
  const candidates = []
  if (pinned) candidates.push(pinned)
  for (const root of installCandidates({ env, platform })) {
    // macOS .app bundles already point at Contents/
    if (platform === 'darwin' && root.endsWith('Contents')) {
      candidates.push(join(root, 'Resources', 'app.asar.unpacked', 'cli'))
      continue
    }
    candidates.push(join(root, ...CLI_RELATIVE))
  }
  for (const cliDir of candidates) {
    const cliEntry = join(cliDir, 'bin', 'codebuddy')
    if (exists(cliEntry)) {
      const installRoot = cliDir.replace(/[\\/]resources[\\/]app\.asar\.unpacked[\\/]cli$/, '')
      return { cliDir, installRoot, cliEntry }
    }
  }
  return null
}

/**
 * Find the Node.js runtime to run the CLI with. The WorkBuddy install ships
 * its own Node (`binaries/node/versions/<v>/node.exe`); using it keeps runtime
 * behavior identical to the one the desktop app uses.
 * @param {{ configDir?: string, exists?: (path: string) => boolean, readdir?: typeof readdirSync, execPath?: string }} [options]
 * @returns {string | null}
 */
export function resolveNodeBinary(options = {}) {
  const exists = options.exists ?? existsSync
  const readdir = options.readdir ?? readdirSync
  const configDir = options.configDir ?? resolveConfigDir()
  const versionsDir = join(configDir, 'binaries', 'node', 'versions')
  if (exists(versionsDir)) {
    const versions = readdir(versionsDir).filter((name) => /^\d+\./.test(name))
    versions.sort(compareVersionsDescending)
    for (const version of versions) {
      for (const binary of ['node.exe', 'node']) {
        const candidate = join(versionsDir, version, binary)
        if (exists(candidate)) return candidate
      }
    }
  }
  const execPath = options.execPath ?? process.execPath
  return execPath && exists(execPath) ? execPath : null
}

/**
 * Descending comparator for `22.22.2-6`-style runtime directory names.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareVersionsDescending(left, right) {
  const parse = (value) => value.split(/[^\d]+/).filter(Boolean).map(Number)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (b[index] ?? 0) - (a[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/**
 * Whether the CLI installation only ships the `lite-wb` bundle, which is the
 * case for every current WorkBuddy build.
 * @param {string} cliDir
 * @param {{ exists?: (path: string) => boolean }} [options]
 * @returns {boolean}
 */
export function isLiteOnly(cliDir, options = {}) {
  const exists = options.exists ?? existsSync
  return !exists(join(cliDir, 'dist', 'codebuddy.js')) && !exists(join(cliDir, 'dist', 'codebuddy'))
}

/**
 * Read the WorkBuddy app version. `<configDir>/last-launch.json` carries the
 * product version (for example `5.8.3`); `<install>/version` only carries the
 * Electron runtime version, which is reported separately.
 * @param {{ installRoot?: string, configDir?: string, readFile?: (path: string) => string, exists?: (path: string) => boolean }} [options]
 * @returns {{ appVersion: string | null, electronVersion: string | null }}
 */
export function readVersions(options = {}) {
  const exists = options.exists ?? existsSync
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'))
  let appVersion = null
  let electronVersion = null
  const lastLaunch = options.configDir ? join(options.configDir, 'last-launch.json') : null
  if (lastLaunch && exists(lastLaunch)) {
    try {
      const parsed = JSON.parse(readFile(lastLaunch))
      if (typeof parsed?.version === 'string') appVersion = parsed.version
      if (typeof parsed?.build === 'string') {
        // keep the build id beside the version for provenance
        appVersion = appVersion === null ? parsed.build : appVersion
      }
    } catch {
      /* ignore a malformed launch record */
    }
  }
  const root = options.installRoot
  if (root) {
    const versionFile = join(root, 'version')
    if (exists(versionFile)) {
      try {
        const text = readFile(versionFile).trim()
        if (text !== '') electronVersion = text
      } catch {
        /* ignore */
      }
    }
  }
  return { appVersion, electronVersion }
}

/**
 * Custom models WorkBuddy is configured with (`<configDir>/models.json`).
 * Only non-secret identity fields are returned; API keys never leave the file.
 * @param {{ configDir?: string, exists?: (path: string) => boolean, readFile?: (path: string) => string }} [options]
 * @returns {Array<{ id: string, vendor?: string, supportsToolCall?: boolean }>}
 */
export function readCustomModels(options = {}) {
  const exists = options.exists ?? existsSync
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'))
  const configDir = options.configDir ?? resolveConfigDir()
  const file = join(configDir, 'models.json')
  if (!exists(file)) return []
  try {
    const parsed = JSON.parse(readFile(file))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => ({
        id: `custom-local:${entry.id}`,
        ...(typeof entry.vendor === 'string' ? { vendor: entry.vendor } : {}),
        ...(typeof entry.supportsToolCall === 'boolean' ? { supportsToolCall: entry.supportsToolCall } : {}),
      }))
  } catch {
    return []
  }
}

/**
 * Complete, read-only description of the local WorkBuddy installation.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, configDir?: string }} [options]
 * @returns {{
 *   found: boolean,
 *   configDir: string,
 *   configDirExists: boolean,
 *   installRoot: string | null,
 *   cliDir: string | null,
 *   cliEntry: string | null,
 *   nodeBinary: string | null,
 *   appVersion: string | null,
 *   liteBundleOnly: boolean,
 *   customModels: Array<{ id: string }>,
 *   projectsDir: string,
 *   reasons: string[],
 * }}
 */
export function discover(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const reasons = []
  const configDir = options.configDir ?? resolveConfigDir({ env, platform })
  const configDirExists = existsSync(configDir)
  if (!configDirExists) reasons.push(`WorkBuddy data directory not found: ${configDir}`)
  const cli = resolveCliDir({ env, platform })
  if (!cli) reasons.push('WorkBuddy CLI not found (set DWB_CLI_DIR to <install>/resources/app.asar.unpacked/cli)')
  const nodeBinary = resolveNodeBinary({ configDir })
  if (!nodeBinary) reasons.push('no Node.js runtime found for the bundled CLI')
  const versions = cli ? readVersions({ installRoot: cli.installRoot, configDir }) : { appVersion: null, electronVersion: null }
  const projectsDir = join(configDir, 'projects')
  const customModels = readCustomModels({ configDir })
  const envDefault = env.DWB_DEFAULT_MODEL?.trim()
  const defaultModel = envDefault && envDefault !== '' ? envDefault : (customModels[0]?.id ?? null)
  return {
    found: Boolean(cli && nodeBinary && configDirExists),
    configDir,
    configDirExists,
    installRoot: cli?.installRoot ?? null,
    cliDir: cli?.cliDir ?? null,
    cliEntry: cli?.cliEntry ?? null,
    nodeBinary,
    appVersion: versions.appVersion,
    electronVersion: versions.electronVersion,
    liteBundleOnly: cli ? isLiteOnly(cli.cliDir) : false,
    customModels,
    defaultModel,
    defaultModelSource: defaultModel === null ? 'account-default' : envDefault ? 'env' : 'first-custom-model',
    projectsDir,
    reasons,
  }
}

/**
 * Project directory name WorkBuddy derives from a working directory.
 * `E:\Code\acme-app` becomes `e-Code-acme-app`.
 * @param {string} cwd
 * @returns {string}
 */
export function projectSlug(cwd) {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  return trimmed
    // `E:\Code\…` becomes `e-Code-…`: the drive colon and its separator collapse
    // into one dash, which is what WorkBuddy's own project directories use.
    .replace(/^([A-Za-z]):[\\/]/, (_match, drive) => `${drive.toLowerCase()}-`)
    .replace(/[\\/]+/g, '-')
}

/**
 * Inverse map used only for display: pick the cwd recorded inside a session
 * file when present.
 * @param {string} slug
 * @returns {string | null}
 */
export function slugToDisplayPath(slug) {
  const match = /^([a-z])-(.+)$/.exec(slug)
  if (!match) return null
  return `${match[1].toUpperCase()}:\\${match[2].replace(/-/g, '\\')}`
}

/**
 * Directory mtime/size probe used by the doctor and by session listing.
 * @param {string} path
 * @returns {{ bytes: number, mtimeMs: number } | null}
 */
export function statFile(path) {
  try {
    const stat = statSync(path)
    return { bytes: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

import assert from 'node:assert/strict'
import test from 'node:test'

import { discover, isLiteOnly, projectSlug, resolveCliDir, resolveConfigDir, resolveNodeBinary } from '../src/discover.mjs'

test('projectSlug matches WorkBuddy project directory names', () => {
  assert.equal(projectSlug('E:\\Code\\acme-app'), 'e-Code-acme-app')
  assert.equal(projectSlug('E:\\Code\\demo-probe'), 'e-Code-demo-probe')
  assert.equal(projectSlug('C:\\Users\\alice\\WorkBuddy\\2026-09-18-14-59-20'), 'c-Users-alice-WorkBuddy-2026-09-18-14-59-20')
  assert.equal(projectSlug('E:\\Code\\acme-app\\'), 'e-Code-acme-app')
})

test('resolveConfigDir honours explicit env, then falls back to the home directory', () => {
  assert.equal(resolveConfigDir({ env: { DWB_CONFIG_DIR: 'D:\\wb' } }), 'D:\\wb')
  assert.equal(resolveConfigDir({ env: { WORKBUDDY_CONFIG_DIR: 'D:\\wb2' } }), 'D:\\wb2')
  assert.equal(resolveConfigDir({ env: { CODEBUDDY_CONFIG_DIR: 'D:\\wb3' } }), 'D:\\wb3')
  assert.equal(resolveConfigDir({ env: { USERPROFILE: 'C:\\Users\\x' } }), 'C:\\Users\\x\\.workbuddy')
})

test('resolveCliDir finds the bundled CLI from an install root', () => {
  const cliDir = 'D:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli'
  const exists = (path) => path === `${cliDir}\\bin\\codebuddy`
  const resolved = resolveCliDir({
    env: {},
    platform: 'win32',
    exists: (path) => path === cliDir || exists(path),
  })
  // installCandidates are checked in order; only the D: default matches here.
  assert.equal(resolved?.cliDir, cliDir)
  assert.equal(resolved?.installRoot, 'D:\\Program Files\\WorkBuddy')
})

test('resolveCliDir honours DWB_CLI_DIR and reports nothing when absent', () => {
  const pinned = 'E:\\custom\\cli'
  assert.equal(resolveCliDir({ env: { DWB_CLI_DIR: pinned }, platform: 'win32', exists: () => true })?.cliDir, pinned)
  assert.equal(resolveCliDir({ env: {}, platform: 'win32', exists: () => false }), null)
})

test('resolveNodeBinary prefers the WorkBuddy-bundled runtime', () => {
  const versionsDir = 'C:\\Users\\x\\.workbuddy\\binaries\\node\\versions'
  const binary = `${versionsDir}\\22.22.2-6\\node.exe`
  const resolved = resolveNodeBinary({
    configDir: 'C:\\Users\\x\\.workbuddy',
    execPath: 'C:\\nodejs\\node.exe',
    exists: (path) => path === versionsDir || path === binary,
    readdir: () => ['22.22.2-6', '18.0.1', 'not-a-version'],
  })
  assert.equal(resolved, binary)
})

test('isLiteOnly is true when only the lite-wb bundle ships', () => {
  const cliDir = 'D:\\wb\\cli'
  assert.equal(isLiteOnly(cliDir, { exists: () => false }), true)
  assert.equal(isLiteOnly(cliDir, { exists: (path) => path.endsWith('codebuddy') }), false)
})

test('discover reports actionable reasons when nothing is installed', () => {
  const result = discover({ env: { USERPROFILE: 'C:\\none', LOCALAPPDATA: 'C:\\none' }, platform: 'linux' })
  assert.equal(result.found, false)
  assert.ok(result.reasons.length >= 2)
  assert.equal(result.cliEntry, null)
})

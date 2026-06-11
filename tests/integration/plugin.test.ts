import { existsSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addPlugin, getInstalledPlugins, getPluginNames } from '../../src/plugin/registry.js'

const TEST_PLUGIN_DIR = resolve(homedir(), '.config', 'restore', 'plugins')

describe('plugin system', () => {
  beforeAll(() => {
    mkdirSync(TEST_PLUGIN_DIR, { recursive: true })
  })

  afterAll(async () => {
    // Clean up test plugin files
    for (const name of getPluginNames()) {
      const p = resolve(TEST_PLUGIN_DIR, `${name}.json`)
      try {
        await rm(p)
      } catch {}
    }
  })

  it('should list builtin plugins', () => {
    const names = getPluginNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain('vscode')
    expect(names).toContain('dotfiles')
  })

  it('should install a plugin from the curated list', () => {
    const result = addPlugin('vscode')
    expect(result).toBe(true)
    expect(existsSync(resolve(TEST_PLUGIN_DIR, 'vscode.json'))).toBe(true)
  })

  it('should list installed plugins', () => {
    const installed = getInstalledPlugins()
    expect(installed).toContain('vscode')
  })

  it('should fail to install unknown plugin', () => {
    const result = addPlugin('nonexistent')
    expect(result).toBe(false)
  })
})

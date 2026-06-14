import { describe, expect, it } from 'vitest'
import { getEnabledPlugins } from '../../src/plugin/loader.js'
import { getBuiltinPlugin, getPluginNames } from '../../src/plugin/registry.js'

describe('plugin registry', () => {
  it('should list builtin plugins', () => {
    const names = getPluginNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain('vscode')
    expect(names).toContain('dotfiles')
    expect(names).toContain('mac-apps')
  })

  it('should resolve enabled plugins from config names', () => {
    const enabled = getEnabledPlugins(['vscode', 'mac-apps'])
    expect(enabled).toHaveLength(2)
    expect(enabled[0]?.name).toBe('vscode')
    expect(enabled[1]?.name).toBe('mac-apps')
  })

  it('should skip unknown plugin names', () => {
    const enabled = getEnabledPlugins(['vscode', 'nonexistent'])
    expect(enabled).toHaveLength(1)
    expect(enabled[0]?.name).toBe('vscode')
  })

  it('should return builtin plugin definitions', () => {
    const plugin = getBuiltinPlugin('mac-apps')
    expect(plugin?.prepare).toBe('mac-apps-inventory')
    expect(plugin?.paths[0]).toContain('mac-apps.json')
  })
})

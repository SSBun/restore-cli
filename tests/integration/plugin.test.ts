import { describe, expect, it } from 'vitest'
import { getEnabledPlugins } from '../../src/plugin/loader.js'
import { getBuiltinPlugin, getPluginNames } from '../../src/plugin/registry.js'

describe('plugin registry', () => {
  it('should list builtin plugins', () => {
    const names = getPluginNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain('restore-cli')
    expect(names).toContain('vscode')
    expect(names).toContain('dotfiles')
    expect(names).toContain('sops')
    expect(names).toContain('mac-apps')
    expect(names).toContain('homebrew')
    expect(names).toContain('raycast')
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

  it('should return VS Code extensions inventory plugin definition', () => {
    const plugin = getBuiltinPlugin('vscode-extensions')
    expect(plugin?.prepare).toBe('vscode-extensions-list')
    expect(plugin?.paths).toEqual(['~/.config/restore/inventory/vscode-extensions.txt'])
  })

  it('should return Homebrew and Raycast plugin definitions', () => {
    const homebrew = getBuiltinPlugin('homebrew')
    expect(homebrew?.prepare).toBe('homebrew-brewfile')
    expect(homebrew?.paths[0]).toContain('Brewfile')

    const raycast = getBuiltinPlugin('raycast')
    expect(raycast?.paths).toEqual([
      '~/.config/restore/inventory/raycast-extensions.json',
      '~/Library/Preferences/com.raycast.macos.plist',
    ])
    expect(raycast?.prepare).toBe('raycast-extensions')
  })

  it('should return restore-cli config plugin definition', () => {
    const plugin = getBuiltinPlugin('restore-cli')
    expect(plugin?.paths).toEqual(['~/.config/restore/config.json5'])
  })

  it('should return SOPS plugin definition', () => {
    const plugin = getBuiltinPlugin('sops')
    expect(plugin?.paths).toEqual(['~/.sops'])
  })
})

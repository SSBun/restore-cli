import { describe, expect, it } from 'vitest'
import { getBuiltinPlugin } from '../../src/plugin/registry.js'
import {
  getAvailableTools,
  getPluginTool,
  getPluginsWithAvailableTools,
  resolveToolScriptPath,
} from '../../src/plugin/tools.js'

describe('plugin tools', () => {
  it('finds plugins with available tool scripts', () => {
    const plugins = getPluginsWithAvailableTools()
    const names = plugins.map((plugin) => plugin.name)
    expect(names).toContain('mac-apps')
    expect(names).toContain('git')
    expect(names).toContain('homebrew')
  })

  it('resolves mac-apps tool scripts', () => {
    expect(resolveToolScriptPath('mac-apps', 'list.sh')).toBeTruthy()
    expect(resolveToolScriptPath('mac-apps', 'refresh.sh')).toBeTruthy()
    expect(resolveToolScriptPath('mac-apps', 'restore-plan.sh')).toBeTruthy()
  })

  it('resolves homebrew tool scripts', () => {
    expect(resolveToolScriptPath('homebrew', 'refresh.sh')).toBeTruthy()
    expect(resolveToolScriptPath('homebrew', 'show.sh')).toBeTruthy()
  })

  it('resolves vscode extensions tool scripts', () => {
    expect(resolveToolScriptPath('vscode-extensions', 'refresh.sh')).toBeTruthy()
    expect(resolveToolScriptPath('vscode-extensions', 'show.sh')).toBeTruthy()
  })

  it('returns tool metadata with descriptions', () => {
    const tool = getPluginTool('mac-apps', 'list')
    expect(tool?.description).toContain('inventory')
  })

  it('filters out missing scripts', () => {
    const plugin = getBuiltinPlugin('mac-apps')
    if (!plugin) throw new Error('mac-apps plugin missing')

    const tools = getAvailableTools({
      ...plugin,
      tools: [
        ...(plugin.tools ?? []),
        { name: 'missing', description: 'missing script', script: 'missing.sh' },
      ],
    })
    expect(tools.some((tool) => tool.name === 'missing')).toBe(false)
  })
})

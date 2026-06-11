import * as p from '@clack/prompts'
import type { Command } from 'commander'
import { loadPlugin } from '../plugin/loader.js'
import {
  addPlugin,
  getBuiltinPlugins,
  getInstalledPlugins,
  getPluginNames,
} from '../plugin/registry.js'

export function registerPluginCommand(program: Command): void {
  const pluginCmd = program.command('plugin').description('Manage backup plugins')

  pluginCmd
    .command('list')
    .description('List available and installed plugins')
    .action(async () => {
      const installed = getInstalledPlugins()
      const all = getBuiltinPlugins()

      p.intro('Plugins')

      for (const plugin of all) {
        const isInstalled = installed.includes(plugin.name)
        const mark = isInstalled ? '✅' : '⬜'
        p.log.info(`${mark} ${plugin.name} — ${plugin.description}`)
      }

      p.outro(`${installed.length}/${all.length} plugins installed`)
    })

  pluginCmd
    .command('add')
    .description('Install a plugin from the curated list')
    .argument('<name>', 'Plugin name (e.g. vscode)')
    .action(async (name: string) => {
      const names = getPluginNames()
      if (!names.includes(name)) {
        p.log.error(`Unknown plugin "${name}". Available: ${names.join(', ')}`)
        process.exit(1)
      }

      const success = addPlugin(name)
      if (success) {
        p.log.success(`Plugin "${name}" installed`)
      } else {
        p.log.error(`Failed to install plugin "${name}"`)
        process.exit(1)
      }
    })
}

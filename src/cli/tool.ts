import * as p from '@clack/prompts'
import { isCancel } from '@clack/prompts'
import type { Command } from 'commander'
import { getBuiltinPlugin } from '../plugin/registry.js'
import { runTool } from '../plugin/tool-runner.js'
import { getAvailableTools, getPluginsWithAvailableTools } from '../plugin/tools.js'
import { error } from '../util/log.js'

export function registerToolCommand(program: Command): void {
  program
    .command('tool', { hidden: true })
    .description('Run an interactive plugin tool')
    .action(async () => {
      const plugins = getPluginsWithAvailableTools()
      if (plugins.length === 0) {
        p.log.warn('No plugin tools are available.')
        return
      }

      p.intro('restore tools')

      const pluginName = await p.select<{ value: string; label: string; hint?: string }[], string>({
        message: 'Select a plugin:',
        options: plugins.map((plugin) => ({
          value: plugin.name,
          label: plugin.name,
          hint: `${getAvailableTools(plugin).length} tool(s) — ${plugin.description}`,
        })),
      })
      if (isCancel(pluginName)) {
        p.cancel('Cancelled')
        return
      }

      const plugin = getBuiltinPlugin(pluginName)
      if (!plugin) {
        error(`Unknown plugin: ${pluginName}`)
        process.exit(1)
      }

      const tools = getAvailableTools(plugin)
      const toolName = await p.select<{ value: string; label: string; hint?: string }[], string>({
        message: `Select a tool for ${plugin.name}:`,
        options: tools.map((tool) => ({
          value: tool.name,
          label: tool.name,
          hint: tool.description,
        })),
      })
      if (isCancel(toolName)) {
        p.cancel('Cancelled')
        return
      }

      const tool = tools.find((entry) => entry.name === toolName)
      if (!tool) {
        error(`Unknown tool: ${toolName}`)
        process.exit(1)
      }

      const exitCode = await runTool(plugin.name, tool)
      if (exitCode === 0) {
        p.outro(`Tool "${tool.name}" finished successfully`)
      } else {
        p.outro(`Tool "${tool.name}" exited with code ${exitCode}`)
        process.exit(exitCode)
      }
    })
}

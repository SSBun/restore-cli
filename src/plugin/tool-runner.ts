import { spawn } from 'node:child_process'
import { extname } from 'node:path'
import { resolveToolScriptPath } from './tools.js'
import type { PluginTool } from './types.js'

/// Run a plugin tool script and inherit stdio. Returns the child exit code.
export async function runTool(pluginName: string, tool: PluginTool): Promise<number> {
  const scriptPath = resolveToolScriptPath(pluginName, tool.script)
  if (!scriptPath) {
    throw new Error(`Tool script not found: ${pluginName}/${tool.script}`)
  }

  const ext = extname(tool.script).toLowerCase()
  const useNode = ext === '.mjs' || ext === '.js'
  const command = useNode ? process.execPath : 'bash'
  const args = [scriptPath]

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise(code ?? 1))
  })
}

import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expandPath } from '../util/path.js'

const execFileAsync = promisify(execFile)

export const VSCODE_EXTENSIONS_RELATIVE_PATH = '~/.config/restore/inventory/vscode-extensions.txt'

async function listCodeExtensions(): Promise<string[]> {
  const { stdout } = await execFileAsync('code', ['--list-extensions'], {
    maxBuffer: 1024 * 1024,
    timeout: 3000,
  })
  return parseCodeExtensions(stdout)
}

export function parseCodeExtensions(output: string): string[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ].sort()
}

export async function generateVSCodeExtensionsInventory(
  outputPath: string,
  listExtensions: () => Promise<string[]> = listCodeExtensions,
): Promise<string> {
  const resolvedOutput = expandPath(outputPath)
  await mkdir(resolve(resolvedOutput, '..'), { recursive: true })

  try {
    const extensions = [...new Set(await listExtensions())].sort()
    await writeFile(resolvedOutput, `${extensions.join('\n')}\n`, 'utf-8')
  } catch (err) {
    const message = (err as Error).message
      .split('\n')
      .map((line) => `# ${line}`)
      .join('\n')
    await writeFile(
      resolvedOutput,
      `# VS Code CLI is not available or listing extensions failed.\n${message}\n`,
      'utf-8',
    )
  }

  return resolvedOutput
}

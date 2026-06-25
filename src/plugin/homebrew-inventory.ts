import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expandPath } from '../util/path.js'

const execFileAsync = promisify(execFile)

export const HOMEBREW_BREWFILE_RELATIVE_PATH = '~/.config/restore/inventory/Brewfile'

async function runBrewBundleDump(outputPath: string): Promise<void> {
  await execFileAsync('brew', ['bundle', 'dump', '--force', '--file', outputPath], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 3000,
  })
}

export async function generateHomebrewBrewfile(
  outputPath: string,
  dump: (outputPath: string) => Promise<void> = runBrewBundleDump,
): Promise<string> {
  const resolvedOutput = expandPath(outputPath)
  await mkdir(resolve(resolvedOutput, '..'), { recursive: true })

  try {
    await dump(resolvedOutput)
  } catch (err) {
    const message = (err as Error).message
      .split('\n')
      .map((line) => `# ${line}`)
      .join('\n')
    await writeFile(
      resolvedOutput,
      `# Homebrew is not available or brew bundle failed.\n${message}\n`,
      'utf-8',
    )
  }

  return resolvedOutput
}

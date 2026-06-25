import { mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { preparePlugins } from './prepare.js'
import {
  generateVSCodeExtensionsInventory,
  parseCodeExtensions,
} from './vscode-extensions-inventory.js'

describe('vscode extensions inventory', () => {
  it('parses and sorts extension ids', () => {
    expect(parseCodeExtensions('b.ext\na.ext\nb.ext\n\n')).toEqual(['a.ext', 'b.ext'])
  })

  it('writes extension ids to an inventory file', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'restore-vscode-extensions-'))
    const outputPath = resolve(root, 'vscode-extensions.txt')

    const resolved = await generateVSCodeExtensionsInventory(outputPath, async () => [
      'ms-vscode.test',
      'github.copilot',
    ])

    expect(resolved).toBe(outputPath)
    expect(readFileSync(outputPath, 'utf-8')).toBe('github.copilot\nms-vscode.test\n')

    await rm(root, { recursive: true, force: true })
  })

  it('preparePlugins generates the VS Code extensions inventory before backup', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'restore-vscode-extensions-prepare-'))
    const outputPath = resolve(root, 'vscode-extensions.txt')
    const originalPath = process.env.PATH

    try {
      process.env.PATH = ''
      await preparePlugins([
        {
          name: 'vscode-extensions',
          description: 'test',
          paths: [outputPath],
          prepare: 'vscode-extensions-list',
        },
      ])
    } finally {
      process.env.PATH = originalPath
    }

    expect(readFileSync(outputPath, 'utf-8')).toContain('VS Code CLI is not available')

    await rm(root, { recursive: true, force: true })
  })
})

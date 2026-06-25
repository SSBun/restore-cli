import { mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateHomebrewBrewfile } from './homebrew-inventory.js'
import { preparePlugins } from './prepare.js'

describe('homebrew inventory', () => {
  it('writes a Brewfile inventory path even when brew is unavailable', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'restore-homebrew-'))
    const outputPath = resolve(root, 'Brewfile')

    const resolved = await generateHomebrewBrewfile(outputPath, async (path) => {
      throw new Error(`brew unavailable for ${path}`)
    })
    const content = readFileSync(outputPath, 'utf-8')

    expect(resolved).toBe(outputPath)
    expect(content).toContain('Homebrew is not available')

    await rm(root, { recursive: true, force: true })
  })

  it('preparePlugins generates the Brewfile before backup', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'restore-homebrew-prepare-'))
    const outputPath = resolve(root, 'Brewfile')
    const originalPath = process.env.PATH

    try {
      process.env.PATH = ''
      await preparePlugins([
        {
          name: 'homebrew',
          description: 'test',
          paths: [outputPath],
          prepare: 'homebrew-brewfile',
        },
      ])
    } finally {
      process.env.PATH = originalPath
    }

    expect(readFileSync(outputPath, 'utf-8')).toContain('Homebrew is not available')

    await rm(root, { recursive: true, force: true })
  })
})

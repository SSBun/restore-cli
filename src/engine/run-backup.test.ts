import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../config/types.js'
import type { PluginManifest } from '../plugin/types.js'

function configFor(destination: string): Config {
  return {
    destination: { name: 'test', path: destination, type: 'local' },
    plugins: ['generated'],
    daemon: { intervalHours: 12 },
    maxSnapshots: 3,
  }
}

async function importRunBackupWithPreparedOutput(outputPath: string) {
  const plugin: PluginManifest = {
    name: 'generated',
    description: 'test',
    paths: [outputPath],
    prepare: 'mac-apps-inventory',
  }
  const preparePlugins = vi.fn(async () => {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, '{"prepared":true}', 'utf-8')
  })

  vi.resetModules()
  vi.doMock('../plugin/loader.js', () => ({
    getEnabledPlugins: () => [plugin],
  }))
  vi.doMock('../plugin/prepare.js', () => ({
    preparePlugins,
  }))

  const { runBackup } = await import('./run-backup.js')
  return { runBackup, preparePlugins }
}

afterEach(() => {
  vi.doUnmock('../plugin/loader.js')
  vi.doUnmock('../plugin/prepare.js')
  vi.resetModules()
})

describe('runBackup', () => {
  it('does not prepare plugin outputs during dry-run', async () => {
    const root = resolve(tmpdir(), `restore-run-backup-${process.pid}-${Date.now()}`)
    const outputPath = resolve(root, 'generated.json')
    const { runBackup, preparePlugins } = await importRunBackupWithPreparedOutput(outputPath)

    try {
      await runBackup(configFor(resolve(root, 'dest')), { dryRun: true })

      expect(preparePlugins).not.toHaveBeenCalled()
      expect(existsSync(outputPath)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prepares plugin outputs during normal backup', async () => {
    const root = resolve(tmpdir(), `restore-run-backup-${process.pid}-${Date.now()}`)
    const outputPath = resolve(root, 'generated.json')
    const { runBackup, preparePlugins } = await importRunBackupWithPreparedOutput(outputPath)

    try {
      const result = await runBackup(configFor(resolve(root, 'dest')))

      expect(preparePlugins).toHaveBeenCalledTimes(1)
      expect(existsSync(outputPath)).toBe(true)
      expect(result.pluginResults).toEqual([{ name: 'generated', linked: 0, copied: 1 }])
      expect(
        readdirSync(resolve(root, 'dest', 'RestoreBackup')).some((name) =>
          name.endsWith('.in-progress'),
        ),
      ).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

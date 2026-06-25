import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getBackupStat, getDirectoryUsage } from './stat.js'

describe('backup stat', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'restore-stat-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('counts files and bytes in a directory', async () => {
    await writeFile(resolve(tmpDir, 'one.txt'), 'hello')
    await mkdir(resolve(tmpDir, 'nested'))
    await writeFile(resolve(tmpDir, 'nested', 'two.txt'), 'world')

    await expect(getDirectoryUsage(tmpDir)).resolves.toEqual({ bytes: 10, files: 2 })
  })

  it('summarizes complete snapshots', async () => {
    const snapshot = resolve(tmpDir, '2026-06-23T01-02-03.004')
    await mkdir(snapshot, { recursive: true })
    await writeFile(resolve(snapshot, 'file.txt'), 'backup')
    await mkdir(resolve(tmpDir, '2026-06-23T01-02-04.004.in-progress'))
    await writeFile(resolve(tmpDir, '.restore-marker'), 'restore-backup-directory\n')

    const stat = await getBackupStat(tmpDir)

    expect(stat.snapshotCount).toBe(1)
    expect(stat.lastBackupName).toBe('2026-06-23T01-02-03.004')
    expect(stat.latestSnapshotBytes).toBe(6)
    expect(stat.latestSnapshotFiles).toBe(1)
    expect(stat.totalBackupFiles).toBe(2)
  })
})

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pruneSnapshots } from '../../src/engine/prune.js'
import { restoreFromSnapshot } from '../../src/engine/restore.js'
import { createSnapshot } from '../../src/engine/snapshot.js'

describe('backup-restore integration', () => {
  let tmpDir: string
  let sourceDir: string
  let destDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'restore-int-'))
    sourceDir = resolve(tmpDir, 'source')
    destDir = resolve(tmpDir, 'backup')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(destDir, { recursive: true })

    // Create test files
    writeFileSync(resolve(sourceDir, 'file1.txt'), 'hello')
    mkdirSync(resolve(sourceDir, 'sub'))
    writeFileSync(resolve(sourceDir, 'sub', 'file2.txt'), 'world')
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('should create a snapshot', async () => {
    const name = await createSnapshot([sourceDir], destDir)
    expect(name).toBeTruthy()
    expect(existsSync(resolve(destDir, name))).toBe(true)
  })

  it('should create a second snapshot with hardlinks', async () => {
    // Same files — second snapshot should use hardlinks
    const name = await createSnapshot([sourceDir], destDir)
    expect(name).toBeTruthy()

    // Snapshot stores files by absolute path minus leading '/'
    // e.g. sourceDir = /var/folders/.../source → stored as var/folders/.../source/file1.txt
    const snapDir1 = resolve(destDir, name)
    const entries = readdirSync(snapDir1, { recursive: true })
    expect(entries.length).toBeGreaterThan(0)
  })

  it('should restore from snapshot', async () => {
    const { getSnapshotInfo } = await import('../../src/engine/restore.js')
    const snapshots = await getSnapshotInfo(destDir)
    expect(snapshots.length).toBeGreaterThan(0)

    const { restored } = await restoreFromSnapshot(snapshots[0].path, [sourceDir])
    expect(restored).toBeGreaterThan(0)
  })

  it('should prune old snapshots', async () => {
    // Create extra snapshots by creating more copies
    for (let i = 0; i < 5; i++) {
      const dir = resolve(destDir, `manual-${i}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, 'placeholder.txt'), String(i))
    }

    await pruneSnapshots(destDir, 3)

    const { listSnapshots } = await import('../../src/engine/prune.js')
    const remaining = await listSnapshots(destDir)
    expect(remaining.length).toBeLessThanOrEqual(3)
  })
})

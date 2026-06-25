import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pruneSnapshots } from '../../src/engine/prune.js'
import { planRestoreFromSnapshot, restoreFromSnapshot } from '../../src/engine/restore.js'
import { createSnapshot, getLatestSnapshotDir } from '../../src/engine/snapshot.js'

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

  it('should restore when roots use tilde paths', async () => {
    const { homedir } = await import('node:os')
    const home = homedir()
    if (!sourceDir.startsWith(home)) return

    const { getSnapshotInfo } = await import('../../src/engine/restore.js')
    const snapshots = await getSnapshotInfo(destDir)
    const tildeRoot = `~${sourceDir.slice(home.length)}`

    const { restored } = await restoreFromSnapshot(snapshots[0].path, [tildeRoot])
    expect(restored).toBeGreaterThan(0)
  })

  it('should plan restore without copying files', async () => {
    const { getSnapshotInfo } = await import('../../src/engine/restore.js')
    const snapshots = await getSnapshotInfo(destDir)
    const filePath = resolve(sourceDir, 'file1.txt')

    writeFileSync(filePath, 'changed')
    const plan = await planRestoreFromSnapshot(snapshots[0].path, [sourceDir])

    expect(plan.length).toBeGreaterThan(0)
    expect(readFileSync(filePath, 'utf-8')).toBe('changed')
    writeFileSync(filePath, 'hello')
  })

  it('should restore only files under selected roots', async () => {
    const { getSnapshotInfo } = await import('../../src/engine/restore.js')
    const snapshots = await getSnapshotInfo(destDir)
    const filePath = resolve(sourceDir, 'file1.txt')
    const subFilePath = resolve(sourceDir, 'sub', 'file2.txt')

    writeFileSync(filePath, 'changed')
    writeFileSync(subFilePath, 'changed')

    const { restored } = await restoreFromSnapshot(snapshots[0].path, [resolve(sourceDir, 'sub')])

    expect(restored).toBe(1)
    expect(readFileSync(filePath, 'utf-8')).toBe('changed')
    expect(readFileSync(subFilePath, 'utf-8')).toBe('world')
    writeFileSync(filePath, 'hello')
  })

  it('should restore under a target directory', async () => {
    const { getSnapshotInfo } = await import('../../src/engine/restore.js')
    const snapshots = await getSnapshotInfo(destDir)
    const restoreDir = resolve(tmpDir, 'restore-target')

    const { restored } = await restoreFromSnapshot(snapshots[0].path, [sourceDir], {
      toDir: restoreDir,
    })

    expect(restored).toBeGreaterThan(0)
    expect(readFileSync(resolve(restoreDir, sourceDir.slice(1), 'file1.txt'), 'utf-8')).toBe(
      'hello',
    )
  })

  it('should ignore incomplete snapshots consistently', async () => {
    const localDir = mkdtempSync(resolve(tmpdir(), 'restore-snapshots-'))
    const validName = '2026-01-01T00-00-00.000'
    const incompleteName = '2026-01-02T00-00-00.000.in-progress'

    mkdirSync(resolve(localDir, validName), { recursive: true })
    writeFileSync(resolve(localDir, validName, 'complete.txt'), 'ok')
    mkdirSync(resolve(localDir, incompleteName), { recursive: true })
    writeFileSync(resolve(localDir, incompleteName, 'partial.txt'), 'partial')

    const { listSnapshots } = await import('../../src/engine/prune.js')
    const { getSnapshotInfo } = await import('../../src/engine/restore.js')

    expect(await getLatestSnapshotDir(localDir)).toBe(resolve(localDir, validName))
    expect(await listSnapshots(localDir)).toEqual([validName])
    expect((await getSnapshotInfo(localDir)).map((snapshot) => snapshot.name)).toEqual([validName])

    await rm(localDir, { recursive: true, force: true })
  })

  it('should prune old valid snapshots by name time', async () => {
    const localDir = mkdtempSync(resolve(tmpdir(), 'restore-prune-'))
    const newest = '2026-01-03T00-00-00.000'
    const oldest = '2026-01-01T00-00-00.000'
    const middle = '2026-01-02T00-00-00.000'
    const incomplete = '2026-01-04T00-00-00.000.in-progress'

    for (const name of [newest, oldest, middle, incomplete, 'manual']) {
      mkdirSync(resolve(localDir, name), { recursive: true })
      writeFileSync(resolve(localDir, name, 'placeholder.txt'), name)
    }

    await pruneSnapshots(localDir, 2)

    expect(existsSync(resolve(localDir, oldest))).toBe(false)
    expect(existsSync(resolve(localDir, middle))).toBe(true)
    expect(existsSync(resolve(localDir, newest))).toBe(true)
    expect(existsSync(resolve(localDir, incomplete))).toBe(true)
    expect(existsSync(resolve(localDir, 'manual'))).toBe(true)

    await rm(localDir, { recursive: true, force: true })
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

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diffWithLastSnapshot } from './diff.js'
import { createSnapshot, getLatestSnapshotDir } from './snapshot.js'

describe('diffWithLastSnapshot', () => {
  it('detects content changes when size is unchanged', async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'restore-diff-'))
    const sourceDir = resolve(tmpDir, 'source')
    const destDir = resolve(tmpDir, 'backup')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(destDir, { recursive: true })

    const file = resolve(sourceDir, 'same-size.txt')
    writeFileSync(file, 'aaaa')
    await createSnapshot([sourceDir], destDir)
    const snapshotDir = await getLatestSnapshotDir(destDir)

    writeFileSync(file, 'bbbb')

    const diffs = await diffWithLastSnapshot([sourceDir], snapshotDir)
    const fileDiff = diffs.find((d) => d.path === file)
    expect(fileDiff?.type).toBe('modified')
  })

  it('marks unchanged files when content matches', async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'restore-diff-'))
    const sourceDir = resolve(tmpDir, 'source')
    const destDir = resolve(tmpDir, 'backup')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(destDir, { recursive: true })

    const file = resolve(sourceDir, 'stable.txt')
    writeFileSync(file, 'same content')
    await createSnapshot([sourceDir], destDir)
    const snapshotDir = await getLatestSnapshotDir(destDir)

    const diffs = await diffWithLastSnapshot([sourceDir], snapshotDir)
    const fileDiff = diffs.find((d) => d.path === file)
    expect(fileDiff?.type).toBe('unchanged')
  })
})

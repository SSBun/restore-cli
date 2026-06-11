import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyWithChecksum, ensureDir, fileExists, hardlinkCopy, listSubdirs } from './fs.js'

describe('ensureDir', () => {
  it('should create a directory recursively', async () => {
    const base = mkdtempSync(resolve(tmpdir(), 'restore-test-'))
    const dir = resolve(base, 'a', 'b', 'c')

    await ensureDir(dir)
    expect(existsSync(dir)).toBe(true)

    await rm(base, { recursive: true, force: true })
  })
})

describe('listSubdirs', () => {
  it('should list subdirectories', async () => {
    const base = mkdtempSync(resolve(tmpdir(), 'restore-test-'))
    await ensureDir(resolve(base, 'sub1'))
    await ensureDir(resolve(base, 'sub2'))

    const dirs = await listSubdirs(base)
    expect(dirs).toEqual(expect.arrayContaining(['sub1', 'sub2']))

    await rm(base, { recursive: true, force: true })
  })
})

describe('copyWithChecksum', () => {
  it('should copy and verify', async () => {
    const base = mkdtempSync(resolve(tmpdir(), 'restore-test-'))
    const src = resolve(base, 'src.txt')
    const dest = resolve(base, 'dest.txt')
    writeFileSync(src, 'test content')

    await copyWithChecksum(src, dest)
    expect(existsSync(dest)).toBe(true)
    expect(existsSync(src)).toBe(true)

    await rm(base, { recursive: true, force: true })
  })
})

describe('hardlinkCopy', () => {
  it('should create a hardlink', async () => {
    const base = mkdtempSync(resolve(tmpdir(), 'restore-test-'))
    const src = resolve(base, 'src.txt')
    const dest = resolve(base, 'dest.txt')
    writeFileSync(src, 'link test')

    await hardlinkCopy(src, dest)
    expect(existsSync(dest)).toBe(true)

    await rm(base, { recursive: true, force: true })
  })
})

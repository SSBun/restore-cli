import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileHash } from './hash.js'

describe('fileHash', () => {
  it('should return SHA256 hash of a file', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'restore-test-'))
    const file = resolve(dir, 'test.txt')
    writeFileSync(file, 'hello world')

    const hash = await fileHash(file)
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
  })

  it('should support different algorithms', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'restore-test-'))
    const file = resolve(dir, 'test.txt')
    writeFileSync(file, 'hello')

    const hash = await fileHash(file, 'md5')
    expect(hash).toBe('5d41402abc4b2a76b9719d911017c592')
  })
})

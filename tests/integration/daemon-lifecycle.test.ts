import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('daemon lifecycle patterns', () => {
  let tmpDir: string
  let pidPath: string

  beforeAll(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'restore-daemon-test-'))
    pidPath = resolve(tmpDir, 'test.pid')
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('should write and read a PID file', () => {
    writeFileSync(pidPath, String(process.pid), 'utf-8')
    expect(existsSync(pidPath)).toBe(true)

    const content = readFileSync(pidPath, 'utf-8')
    expect(Number(content.trim())).toBe(process.pid)
  })

  it('should detect running process via PID', () => {
    writeFileSync(pidPath, String(process.pid), 'utf-8')

    const pid = Number(readFileSync(pidPath, 'utf-8').trim())
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  it('should detect missing PID file', () => {
    const missingPath = resolve(tmpDir, 'nonexistent.pid')
    expect(existsSync(missingPath)).toBe(false)
  })

  it('should remove PID file', () => {
    writeFileSync(pidPath, String(process.pid), 'utf-8')
    expect(existsSync(pidPath)).toBe(true)

    unlinkSync(pidPath)
    expect(existsSync(pidPath)).toBe(false)
  })

  it('should handle stale PID (process no longer exists)', () => {
    writeFileSync(pidPath, '999999999', 'utf-8')

    const pid = Number(readFileSync(pidPath, 'utf-8').trim())
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

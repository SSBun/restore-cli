import { describe, expect, it } from 'vitest'
import { expandPath, getBackupRoot } from './path.js'

describe('path helpers', () => {
  it('expands tilde paths', () => {
    const home = process.env.HOME || '/tmp'
    expect(expandPath('~/.zshrc')).toBe(`${home}/.zshrc`)
    expect(expandPath('~')).toBe(home)
  })

  it('builds the readable mirror under its destination', () => {
    expect(getBackupRoot('/tmp/backup')).toBe('/tmp/backup/RestoreBackup')
  })
})

import { describe, expect, it } from 'vitest'
import { expandPath, getBackupRoot, isUnderRoot, toSnapshotRelative } from './path.js'

describe('path helpers', () => {
  it('expands tilde paths', () => {
    const home = process.env.HOME || '/tmp'
    expect(expandPath('~/.zshrc')).toBe(`${home}/.zshrc`)
    expect(expandPath('~')).toBe(home)
  })

  it('builds backup root under destination', () => {
    expect(getBackupRoot('/tmp/backup')).toBe('/tmp/backup/RestoreBackup')
  })

  it('converts absolute paths to snapshot-relative form', () => {
    expect(toSnapshotRelative('/Users/test/file.txt')).toBe('Users/test/file.txt')
  })

  it('matches snapshot paths under tilde roots', () => {
    const home = process.env.HOME || '/tmp'
    const rel = `${home.slice(1)}/.config/nvim/init.lua`
    expect(isUnderRoot(rel, '~/.config/nvim')).toBe(true)
    expect(isUnderRoot(rel, '~/.ssh')).toBe(false)
  })

  it('matches exact file roots', () => {
    const home = process.env.HOME || '/tmp'
    const rel = `${home.slice(1)}/.ssh/config`
    expect(isUnderRoot(rel, '~/.ssh/config')).toBe(true)
  })
})

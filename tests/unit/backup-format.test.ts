import { describe, expect, it } from 'vitest'
import {
  formatBackupFooter,
  formatChangesList,
  formatPluginTable,
  shortenPath,
} from '../../src/cli/backup-format.js'

describe('backup-format', () => {
  it('formats plugin table with aligned columns', () => {
    const lines = formatPluginTable([
      { name: 'iterm2', unchanged: 0, updated: 1, new: 0 },
      { name: 'mac-apps', unchanged: 0, updated: 1, new: 0, note: '138 apps' },
    ])

    expect(lines[0]).toContain('PLUGIN')
    expect(lines[0]).toContain('UNCHANGED')
    expect(lines[1]).toContain('iterm2')
    expect(lines[2]).toContain('mac-apps')
    expect(lines[2]).toContain('138 apps')
  })

  it('formats changes with shortened paths', () => {
    const home = process.env.HOME || '/tmp'
    const lines = formatChangesList([`${home}/.zshrc`])
    expect(lines.join('\n')).toContain('~/.zshrc')
  })

  it('formats footer with optional prune count', () => {
    const withPrune = formatBackupFooter('2026-06-14T08-00-00.000', 10, 2, 1).join('\n')
    expect(withPrune).toContain('pruned 1')

    const withoutPrune = formatBackupFooter('2026-06-14T08-00-00.000', 10, 2, 0).join('\n')
    expect(withoutPrune).not.toContain('pruned')
  })

  it('shortens home paths', () => {
    const home = process.env.HOME || '/tmp'
    expect(shortenPath(`${home}/Documents/test.txt`)).toBe('~/Documents/test.txt')
  })
})

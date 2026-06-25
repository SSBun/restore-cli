import { describe, expect, it } from 'vitest'
import {
  formatBackupFooter,
  formatChangedPlugins,
  formatChangesList,
  formatPlanSummary,
  formatPluginTable,
  formatSkippedPaths,
  formatSkippedSummary,
  formatSyncFile,
  formatSyncResult,
  formatSyncStart,
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

  it('limits long change lists', () => {
    const lines = formatChangesList(['/tmp/a', '/tmp/b', '/tmp/c'], 2)

    expect(lines.join('\n')).toContain('/tmp/a')
    expect(lines.join('\n')).toContain('/tmp/b')
    expect(lines.join('\n')).not.toContain('/tmp/c')
    expect(lines.join('\n')).toContain('1 more not shown')
  })

  it('formats skipped paths as warnings', () => {
    const home = process.env.HOME || '/tmp'
    const lines = formatSkippedPaths([{ path: `${home}/missing.txt`, reason: 'missing' }])

    expect(lines.join('\n')).toContain('Warnings')
    expect(lines.join('\n')).toContain('~/missing.txt')
    expect(lines.join('\n')).toContain('missing')
  })

  it('formats footer with optional prune count', () => {
    const withPrune = formatBackupFooter('2026-06-14T08-00-00.000', 10, 2, 1).join('\n')
    expect(withPrune).toContain('pruned 1')

    const withoutPrune = formatBackupFooter('2026-06-14T08-00-00.000', 10, 2, 0).join('\n')
    expect(withoutPrune).not.toContain('pruned')
  })

  it('formats footer with optional prune failures', () => {
    const lines = formatBackupFooter('2026-06-14T08-00-00.000', 10, 2, 0, 1).join('\n')
    expect(lines).toContain('prune failed 1')
  })

  it('formats per-plugin sync results', () => {
    const lines = formatSyncResult([
      { name: 'git', linked: 1, copied: 0 },
      { name: 'raycast', linked: 0, copied: 2 },
    ]).join('\n')

    expect(lines).toContain('Synced plugins')
    expect(lines).toContain('git')
    expect(lines).toContain('1 linked')
    expect(lines).toContain('raycast')
    expect(lines).toContain('2 copied')
  })

  it('formats a compact plan summary', () => {
    const lines = formatPlanSummary(
      [
        { name: 'git', unchanged: 1, updated: 1, new: 0 },
        { name: 'vim', unchanged: 2, updated: 0, new: 1 },
      ],
      ['/tmp/.gitconfig', '/tmp/init.lua'],
      [{ path: '/tmp/missing', reason: 'missing' }],
    ).join('\n')

    expect(lines).toContain('2 plugins')
    expect(lines).toContain('3 unchanged')
    expect(lines).toContain('2 changed')
    expect(lines).toContain('1 skipped')
  })

  it('formats changed plugin summaries', () => {
    const lines = formatChangedPlugins(
      [
        { name: 'git', unchanged: 0, updated: 1, new: 0 },
        { name: 'vim', unchanged: 2, updated: 0, new: 0 },
        { name: 'mac-apps', unchanged: 0, updated: 1, new: 0, note: '139 apps' },
      ],
      [
        { name: 'git', linked: 0, copied: 1 },
        { name: 'vim', linked: 2, copied: 0 },
        { name: 'mac-apps', linked: 0, copied: 1 },
      ],
    ).join('\n')

    expect(lines).toContain('Changed plugins')
    expect(lines).toContain('git')
    expect(lines).toContain('1 copied')
    expect(lines).not.toContain('vim')
    expect(lines).toContain('139 apps')
  })

  it('formats skipped path summaries', () => {
    expect(formatSkippedSummary(0)).toEqual([])
    expect(formatSkippedSummary(4).join('\n')).toContain('4 paths')
    expect(formatSkippedSummary(4).join('\n')).toContain('--verbose')
  })

  it('formats live sync progress', () => {
    const home = process.env.HOME || '/tmp'

    expect(formatSyncStart('git', 2)).toContain('git')
    expect(formatSyncStart('git', 2)).toContain('2 files')

    const line = formatSyncFile({
      pluginName: 'git',
      action: 'copy',
      path: `${home}/.gitconfig`,
      current: 1,
      total: 2,
      linked: 0,
      copied: 0,
    })

    expect(line).toContain('copy')
    expect(line).toContain('1/2')
    expect(line).toContain('~/.gitconfig')
  })

  it('shortens home paths', () => {
    const home = process.env.HOME || '/tmp'
    expect(shortenPath(`${home}/Documents/test.txt`)).toBe('~/Documents/test.txt')
  })
})

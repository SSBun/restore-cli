import { homedir } from 'node:os'
import type { PluginBackupRow } from '../engine/run-backup.js'
import { color } from '../util/color.js'

export type { PluginBackupRow }

const PLUGIN_COL = 12
const UNCHANGED_COL = 9
const UPDATED_COL = 7
const NEW_COL = 3

function padNum(value: number, width: number): string {
  return String(value).padStart(width)
}

export function shortenPath(filePath: string): string {
  const home = process.env.HOME || homedir()
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath
}

export function formatBackupHeader(destinationName: string, backupRoot: string): string[] {
  return [
    '',
    `${color.bold('Backup')} ${color.dim('→')} ${color.cyan(destinationName)}`,
    color.dim(backupRoot),
    '',
  ]
}

export function formatPluginTable(rows: PluginBackupRow[]): string[] {
  const lines = [
    `${color.bold('PLUGIN'.padEnd(PLUGIN_COL))}  ${'UNCHANGED'.padStart(UNCHANGED_COL)}  ${'UPDATED'.padStart(UPDATED_COL)}  ${'NEW'.padStart(NEW_COL)}  ${color.bold('NOTE')}`,
  ]

  for (const row of rows) {
    const note = row.note ? color.dim(row.note) : ''
    lines.push(
      `${color.bold(row.name.padEnd(PLUGIN_COL))}  ${padNum(row.unchanged, UNCHANGED_COL)}  ${padNum(row.updated, UPDATED_COL)}  ${padNum(row.new, NEW_COL)}  ${note}`,
    )
  }

  return lines
}

export function formatChangesList(changes: string[]): string[] {
  if (changes.length === 0) return []

  const lines = ['', color.bold(`Changes (${changes.length}):`)]
  for (const change of changes) {
    lines.push(`  ${color.yellow('~')} ${shortenPath(change)}`)
  }
  return lines
}

export function formatBackupFooter(
  snapshotName: string,
  linked: number,
  copied: number,
  pruned: number,
): string[] {
  const parts = [
    color.bold('Snapshot'),
    color.dim(snapshotName),
    color.dim('·'),
    color.dim(`${linked} linked`),
    color.dim('·'),
    color.dim(`${copied} copied`),
  ]
  if (pruned > 0) {
    parts.push(color.dim('·'), color.dim(`pruned ${pruned}`))
  }

  return ['', parts.join(' '), `${color.green('✓')} ${color.bold('Done')}`, '']
}

export function formatDryRunFooter(): string[] {
  return ['', color.dim('[dry-run] No snapshot written.'), '']
}

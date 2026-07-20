import { homedir } from 'node:os'
import type { CapturePlan, ResolvedSource } from '../catalog/types.js'
import type { SkippedPath } from '../engine/diff.js'
import type {
  BackupFileSyncProgress,
  PluginBackupRow,
  PluginSyncResult,
} from '../engine/run-backup.js'
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

function formatSourceTags(source: ResolvedSource): string {
  const requirement =
    source.requirement === 'required'
      ? color.yellow(source.requirement)
      : color.dim(source.requirement)
  const sensitivity =
    source.sensitivity === 'secret'
      ? color.red(source.sensitivity)
      : source.sensitivity === 'private'
        ? color.yellow(source.sensitivity)
        : color.dim(source.sensitivity)
  return `${requirement} ${color.dim('·')} ${sensitivity} ${color.dim(`· ${source.expectedType}`)}`
}

export function formatCaptureScope(plan: CapturePlan): string[] {
  const sourcesByPlugin = new Map<string, ResolvedSource[]>()
  for (const source of plan.sources) {
    const sources = sourcesByPlugin.get(source.plugin) ?? []
    sources.push(source)
    sourcesByPlugin.set(source.plugin, sources)
  }
  const lines = [color.bold(`Sources (${plan.sources.length})`)]

  for (const [plugin, sources] of sourcesByPlugin) {
    lines.push(`  ${color.cyan(plugin)} ${color.dim(`(${sources.length})`)}`)
    const nameWidth = Math.max(...sources.map((source) => source.name.length))
    for (const source of sources) {
      lines.push(`    ${source.name.padEnd(nameWidth)}  ${formatSourceTags(source)}`)
      lines.push(`      ${color.dim(shortenPath(source.path))}`)
    }
  }

  return lines
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

export function formatChangesList(changes: string[], limit = 20): string[] {
  if (changes.length === 0) return []

  const lines = ['', color.bold(`Changes (${changes.length}):`)]
  for (const change of changes.slice(0, limit)) {
    lines.push(`  ${color.yellow('~')} ${shortenPath(change)}`)
  }
  const hidden = changes.length - limit
  if (hidden > 0) {
    lines.push(`  ${color.dim(`... ${hidden} more not shown`)}`)
  }
  return lines
}

export function formatSkippedPaths(skippedPaths: SkippedPath[]): string[] {
  if (skippedPaths.length === 0) return []

  const lines = ['', color.yellow(`Warnings (${skippedPaths.length} skipped):`)]
  for (const skipped of skippedPaths) {
    lines.push(`  ${color.yellow('!')} ${shortenPath(skipped.path)} ${color.dim(skipped.reason)}`)
  }
  return lines
}

export function formatSyncResult(results: PluginSyncResult[]): string[] {
  if (results.length === 0) return []

  const lines = ['', color.bold('Synced plugins:')]
  for (const result of results) {
    lines.push(
      `  ${color.green('✓')} ${result.name.padEnd(PLUGIN_COL)}  ${padNum(
        result.linked,
        UNCHANGED_COL,
      )} linked  ${padNum(result.copied, UPDATED_COL)} copied`,
    )
  }
  return lines
}

export function formatPlanSummary(
  rows: PluginBackupRow[],
  changes: string[],
  skippedPaths: SkippedPath[],
): string[] {
  const unchanged = rows.reduce((total, row) => total + row.unchanged, 0)
  const updated = rows.reduce((total, row) => total + row.updated, 0)
  const added = rows.reduce((total, row) => total + row.new, 0)
  const changed = updated + added
  const parts = [
    color.bold('Plan'),
    color.dim(`· ${rows.length} plugins`),
    color.dim(`· ${unchanged} unchanged`),
    color.dim(`· ${changed} changed`),
  ]

  if (changes.length !== changed) {
    parts.push(color.dim(`· ${changes.length} changed entries`))
  }
  if (skippedPaths.length > 0) {
    parts.push(color.dim(`· ${skippedPaths.length} skipped`))
  }

  return ['', parts.join(' ')]
}

export function formatStageDone(
  current: number,
  total: number,
  label: string,
  detail: string,
): string {
  return `[${current}/${total}] ${label.padEnd(22)} ${color.green('done')} ${color.dim(detail)}`
}

export function formatChangedPlugins(
  rows: PluginBackupRow[],
  results: PluginSyncResult[],
): string[] {
  const changed = rows.filter((row) => row.updated > 0 || row.new > 0)
  if (changed.length === 0) return ['', `Changed plugins: ${color.dim('none')}`]

  const resultByName = new Map(results.map((result) => [result.name, result]))
  const lines = ['', color.bold('Changed plugins:')]
  for (const row of changed) {
    const result = resultByName.get(row.name)
    const linked = result?.linked ?? row.unchanged
    const copied = result?.copied ?? row.updated + row.new
    const parts = []
    if (linked > 0) parts.push(`${linked} linked`)
    if (copied > 0) parts.push(`${copied} copied`)
    const counts = parts.length > 0 ? parts.join(', ') : 'no files'
    const note = row.note ? ` ${color.dim(`(${row.note})`)}` : ''
    lines.push(`  ${row.name.padEnd(20)} ${color.dim(counts)}${note}`)
  }
  return lines
}

export function formatSkippedSummary(count: number): string[] {
  if (count === 0) return []
  return [`Skipped: ${color.yellow(`${count} paths`)} ${color.dim('(use --verbose for details)')}`]
}

export function formatSyncStart(pluginName: string, fileTotal: number): string {
  const fileLabel = fileTotal === 1 ? 'file' : 'files'
  return `  ${color.cyan('>')} ${color.bold(pluginName)} ${color.dim(`(${fileTotal} ${fileLabel})`)}`
}

export function formatSyncPluginDone(result: PluginSyncResult): string {
  return `  ${color.green('✓')} ${result.name} ${color.dim(`· ${result.linked} linked · ${result.copied} copied`)}`
}

export function formatPluginPhaseStart(pluginName: string, current: number, total: number): string {
  return `  ${color.cyan('>')} ${pluginName} ${color.dim(`(${current}/${total})`)}`
}

export function formatPluginPhaseDone(pluginName: string, current: number, total: number): string {
  return `  ${color.green('✓')} ${pluginName} ${color.dim(`(${current}/${total})`)}`
}

export function formatSyncFile(event: BackupFileSyncProgress): string {
  const actionLabel = event.action.padEnd(4)
  const action = event.action === 'link' ? color.dim(actionLabel) : color.yellow(actionLabel)
  const count = `${event.current}/${event.total}`.padStart(9)
  return `    ${action} ${color.dim(count)} ${shortenPath(event.path)}`
}

export function formatBackupFooter(
  snapshotName: string,
  linked: number,
  copied: number,
  pruned: number,
  pruneFailed = 0,
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
  if (pruneFailed > 0) {
    parts.push(color.dim('·'), color.dim(`prune failed ${pruneFailed}`))
  }

  return ['', parts.join(' '), `${color.green('✓')} ${color.bold('Done')}`, '']
}

export function formatDryRunFooter(): string[] {
  return ['', color.dim('[dry-run] No snapshot written.'), '']
}

import { homedir } from 'node:os'
import type { CapturePlan, ResolvedSource } from '../catalog/types.js'
import type { MirrorDiff } from '../mirror/index.js'
import { color } from '../util/color.js'

export function shortenPath(filePath: string): string {
  const home = process.env.HOME || homedir()
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath
}

export function formatBackupHeader(destinationName: string, backupRoot: string): string[] {
  return [
    '',
    `${color.bold('Backup')} ${color.dim('\u2192')} ${color.cyan(destinationName)}`,
    color.dim(backupRoot),
    '',
  ]
}

function sourceTags(source: ResolvedSource): string {
  return `${source.requirement} · ${source.sensitivity} · ${source.expectedType}`
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

function tableRule(
  left: string,
  separator: string,
  right: string,
  widths: readonly number[],
): string {
  return `${left}${widths.map((width) => '─'.repeat(width + 2)).join(separator)}${right}`
}

function cell(value: string, width: number): string {
  return ` ${value.padEnd(width)} `
}

function styledCell(value: string, visibleLength: number, width: number): string {
  return ` ${value}${' '.repeat(width - visibleLength + 1)}`
}

export function formatCaptureScope(plan: CapturePlan): string[] {
  const sourcesByPlugin = new Map<string, ResolvedSource[]>()
  for (const source of plan.sources) {
    const sources = sourcesByPlugin.get(source.plugin) ?? []
    sources.push(source)
    sourcesByPlugin.set(source.plugin, sources)
  }

  const plugins = [...sourcesByPlugin.entries()]
  const pluginLabels = plugins.map(([plugin, sources]) => `${plugin} (${sources.length})`)
  const pluginWidth = Math.max('Plugin'.length, ...pluginLabels.map((label) => label.length))
  const sourceWidth = Math.max('Source'.length, ...plan.sources.map((source) => source.name.length))
  const detailsWidth = Math.max(
    'Contract / Path'.length,
    ...plan.sources
      .flatMap((source) => [sourceTags(source), shortenPath(source.path)])
      .map((value) => value.length),
  )
  const widths = [pluginWidth, sourceWidth, detailsWidth]
  const lines = [
    color.bold(`Sources (${plan.sources.length})`),
    tableRule('┌', '┬', '┐', widths),
    `│${styledCell(color.bold('Plugin'), 'Plugin'.length, pluginWidth)}│${styledCell(color.bold('Source'), 'Source'.length, sourceWidth)}│${styledCell(color.bold('Contract / Path'), 'Contract / Path'.length, detailsWidth)}│`,
    tableRule('├', '┼', '┤', widths),
  ]

  for (const [pluginIndex, [plugin, sources]] of plugins.entries()) {
    const pluginLabel = `${plugin} (${sources.length})`
    for (const [sourceIndex, source] of sources.entries()) {
      const tags = sourceTags(source)
      const path = shortenPath(source.path)
      const pluginCell =
        sourceIndex === 0
          ? styledCell(color.cyan(pluginLabel), pluginLabel.length, pluginWidth)
          : cell('', pluginWidth)
      lines.push(
        `│${pluginCell}│${cell(source.name, sourceWidth)}│${styledCell(formatSourceTags(source), tags.length, detailsWidth)}│`,
        `│${cell('', pluginWidth)}│${cell('', sourceWidth)}│${styledCell(color.dim(path), path.length, detailsWidth)}│`,
      )
      if (sourceIndex < sources.length - 1) {
        lines.push(
          `│${' '.repeat(pluginWidth + 2)}├${'─'.repeat(sourceWidth + 2)}┼${'─'.repeat(detailsWidth + 2)}┤`,
        )
      }
    }
    if (pluginIndex < plugins.length - 1) lines.push(tableRule('├', '┼', '┤', widths))
  }

  lines.push(tableRule('└', '┴', '┘', widths))
  return lines
}

function formatAction(action: MirrorDiff['action']): string {
  if (action === 'create') return color.green(action)
  if (action === 'modify') return color.yellow(action)
  return color.red(action)
}

export function formatMirrorDiff(diff: readonly MirrorDiff[], title = 'Changes'): string[] {
  if (diff.length === 0) return [color.bold(`${title} (0)`), color.dim('  Already in sync')]
  const actionWidth = Math.max('Action'.length, ...diff.map((entry) => entry.action.length))
  const sourceWidth = Math.max('Source'.length, ...diff.map((entry) => entry.sourceId.length))
  const pathWidth = Math.max('Path'.length, ...diff.map((entry) => entry.relativePath.length))
  const typeWidth = Math.max('Type'.length, ...diff.map((entry) => entry.type.length))
  const widths = [actionWidth, sourceWidth, pathWidth, typeWidth]
  const lines = [
    color.bold(`${title} (${diff.length})`),
    tableRule('┌', '┬', '┐', widths),
    `│${styledCell(color.bold('Action'), 'Action'.length, actionWidth)}│${styledCell(color.bold('Source'), 'Source'.length, sourceWidth)}│${styledCell(color.bold('Path'), 'Path'.length, pathWidth)}│${styledCell(color.bold('Type'), 'Type'.length, typeWidth)}│`,
    tableRule('├', '┼', '┤', widths),
  ]
  for (const [index, entry] of diff.entries()) {
    lines.push(
      `│${styledCell(formatAction(entry.action), entry.action.length, actionWidth)}│${cell(entry.sourceId, sourceWidth)}│${cell(entry.relativePath, pathWidth)}│${cell(entry.type, typeWidth)}│`,
    )
    if (index < diff.length - 1) lines.push(tableRule('├', '┼', '┤', widths))
  }
  lines.push(tableRule('└', '┴', '┘', widths))
  return lines
}

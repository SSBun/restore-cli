import { homedir } from 'node:os'
import type { CapturePlan, ResolvedSource } from '../catalog/types.js'
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
  return `${requirement} ${color.dim('\u00b7')} ${sensitivity} ${color.dim(`\u00b7 ${source.expectedType}`)}`
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

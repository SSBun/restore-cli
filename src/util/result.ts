import type { Command } from 'commander'
import { color } from './color.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function rootCommand(command: Command): Command {
  let current = command
  while (current.parent) current = current.parent
  return current
}

export function commandSupportsOutputMode(command: Command): boolean {
  const root = rootCommand(command)
  return root.options.some((option) => option.long === '--json')
}

export function commandUsesJson(command: Command): boolean {
  const root = rootCommand(command)
  const declaresJson = commandSupportsOutputMode(command)
  // Direct command unit consumers predate the root option and retain the stable JSON contract.
  return declaresJson ? root.opts().json === true : true
}

function identityLine(label: string, value: unknown): string[] {
  const resolved = text(value)
  return resolved ? [`  ${color.dim(label.padEnd(18))}${resolved}`] : []
}

function humanizeLabel(value: string): string {
  const words = value
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let amount = value
  let unit = -1
  do {
    amount /= 1024
    unit += 1
  } while (amount >= 1024 && unit < units.length - 1)
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`
}

function countValue(name: string, value: string | number): string {
  if (typeof value === 'string') return value
  return name.startsWith('bytes')
    ? formatBytes(value)
    : new Intl.NumberFormat('en-US').format(value)
}

function formatCounts(value: unknown): string[] {
  const counts = object(value)
  if (!counts) return []
  const entries = Object.entries(counts).filter(
    ([, count]) => typeof count === 'number' || typeof count === 'string',
  )
  if (entries.length === 0) return []
  const labels = entries.map(([name]) => humanizeLabel(name))
  const width = Math.max(...labels.map((label) => label.length))
  return [
    '',
    color.bold('Counts'),
    ...entries.map(
      ([name, count], index) =>
        `  ${color.dim(labels[index].padEnd(width + 2))}${countValue(name, count as string | number)}`,
    ),
  ]
}

function formatIssues(value: unknown, state?: string, primaryCategory?: string): string[] {
  if (!Array.isArray(value)) return []
  const visible = value.slice(0, 16)
  const items = visible.flatMap((candidate) => {
    const issue = object(candidate)
    const code = text(issue?.code)
    if (!code) return []
    const message = text(issue?.message)
    const category = text(issue?.category)
    const severe = state === 'failure' && category === primaryCategory
    const icon = severe ? color.red('✗') : color.yellow('!')
    const heading = severe ? color.red(code) : color.yellow(code)
    return [
      `  ${icon} ${heading}${category ? ` ${color.dim(`[${category}]`)}` : ''}`,
      ...(message ? [`    ${message}`] : []),
      ...identityLine('Next', issue?.nextAction).map((line) => `  ${line}`),
    ]
  })
  const hidden = value.length - visible.length
  return items.length > 0
    ? [
        '',
        color.bold(`Issues (${value.length})`),
        ...items,
        ...(hidden > 0 ? [`  ${color.dim(`... ${hidden} more not shown`)}`] : []),
      ]
    : []
}

function formatSoftware(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const items = value.slice(0, 100).flatMap((candidate) => {
    const item = object(candidate)
    const name = text(item?.name) ?? text(item?.id)
    if (!name) return []
    const status = text(item?.status) ?? text(item?.action) ?? 'review'
    return [`  ${color.cyan(name)} ${color.dim(status)}`]
  })
  return items.length > 0 ? ['', color.bold('Software'), ...items] : []
}

function formatManualDependencies(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const items = value.slice(0, 100).flatMap((candidate) => {
    if (typeof candidate === 'string') return [`  ${candidate}`]
    const item = object(candidate)
    const name = text(item?.name) ?? text(item?.id) ?? text(item?.description)
    return name ? [`  ${name}`] : []
  })
  return items.length > 0 ? ['', color.bold('Manual steps'), ...items] : []
}

function formatHeadline(operation: string | undefined, state: string | undefined): string[] {
  if (!operation && !state) return []
  const name = humanizeLabel(operation ?? 'operation')
  const status = state ?? 'completed'
  if (status === 'success')
    return [`${color.green('✓')} ${color.bold(name)} ${color.green(status)}`]
  if (status === 'failure') return [`${color.red('✗')} ${color.bold(name)} ${color.red(status)}`]
  return [`${color.yellow('!')} ${color.bold(name)} ${color.yellow(status)}`]
}

export function formatHumanResult(value: unknown): string {
  const result = object(value)
  if (!result) return 'Operation result is unavailable'
  const repository = object(result.repository)
  const recoveryPoint = object(result.recoveryPoint)
  const staging = object(result.staging)
  const scheduler = object(result.scheduler)
  const operation = text(result.operation)
  const state = text(result.state)
  const category = text(result.category)
  const lines = [
    ...formatHeadline(operation, state),
    ...identityLine('Category', category === 'success' ? undefined : category),
    ...identityLine('Repository', result.repositoryId ?? repository?.id),
    ...identityLine(
      'Repository path',
      result.repositoryPath ?? result.repositoryLocation ?? repository?.path,
    ),
    ...identityLine('Recovery point', result.pointId ?? recoveryPoint?.id),
    ...identityLine('Staging', result.stagingPath ?? staging?.path),
  ]
  if (typeof result.dryRun === 'boolean') {
    lines.push(...identityLine('Dry run', result.dryRun ? 'yes' : 'no'))
  }
  if (typeof result.degraded === 'boolean') {
    lines.push(...identityLine('Degraded', result.degraded ? 'yes' : 'no'))
  } else if (typeof scheduler?.degraded === 'boolean') {
    lines.push(...identityLine('Degraded', scheduler.degraded ? 'yes' : 'no'))
  }
  lines.push(...formatCounts(result.counts))
  lines.push(...formatSoftware(result.software))
  lines.push(...formatManualDependencies(result.manualDependencies))
  lines.push(...formatIssues(result.issues, state, category))
  const nextAction = text(result.nextAction)
  if (nextAction) lines.push('', color.bold('Next'), `  ${nextAction}`)
  return lines.length > 0 ? lines.join('\n') : 'Operation completed'
}

export function serializeCliResult(value: unknown, json: boolean): string {
  return json ? JSON.stringify(value) : formatHumanResult(value)
}

export function emitCliResult(
  command: Command,
  writeStdout: (value: string) => void,
  value: unknown,
): void {
  writeStdout(serializeCliResult(value, commandUsesJson(command)))
}

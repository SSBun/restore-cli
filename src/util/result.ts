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
  return rootCommand(command).options.some((option) => option.long === '--json')
}

export function commandUsesJson(command: Command): boolean {
  const root = rootCommand(command)
  return commandSupportsOutputMode(command) ? root.opts().json === true : true
}

function humanize(value: string): string {
  const words = value
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

function identity(label: string, value: unknown): string[] {
  const resolved = text(value)
  return resolved ? [`  ${color.dim(label.padEnd(18))}${resolved}`] : []
}

function headline(operation?: string, state?: string): string[] {
  if (!operation && !state) return []
  const name = humanize(operation ?? 'operation')
  const status = state ?? 'completed'
  if (status === 'success')
    return [`${color.green('✓')} ${color.bold(name)} ${color.green(status)}`]
  if (status === 'failure') return [`${color.red('✗')} ${color.bold(name)} ${color.red(status)}`]
  return [`${color.yellow('!')} ${color.bold(name)} ${color.yellow(status)}`]
}

function formatCounts(value: unknown): string[] {
  const counts = object(value)
  if (!counts) return []
  const entries = Object.entries(counts).filter(([, count]) => typeof count === 'number')
  if (entries.length === 0) return []
  const labels = entries.map(([name]) => humanize(name))
  const width = Math.max(...labels.map((label) => label.length))
  return [
    '',
    color.bold('Counts'),
    ...entries.map(
      ([, count], index) =>
        `  ${color.dim(labels[index].padEnd(width + 2))}${new Intl.NumberFormat('en-US').format(count as number)}`,
    ),
  ]
}

function formatIssues(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return []
  const visible = value.slice(0, 16)
  const lines = visible.flatMap((candidate) => {
    const issue = object(candidate)
    const code = text(issue?.code)
    if (!code) return []
    return [
      `  ${color.yellow('!')} ${color.yellow(code)}`,
      ...(text(issue?.message) ? [`    ${text(issue?.message)}`] : []),
      ...identity('Next', issue?.nextAction).map((line) => `  ${line}`),
    ]
  })
  const hidden = value.length - visible.length
  return [
    '',
    color.bold(`Issues (${value.length})`),
    ...lines,
    ...(hidden > 0 ? [`  ${color.dim(`... ${hidden} more not shown`)}`] : []),
  ]
}

export function formatHumanResult(value: unknown): string {
  const result = object(value)
  if (!result) return 'Operation result is unavailable'
  const operation = text(result.operation)
  const state = text(result.state)
  const category = text(result.category)
  const lines = [
    ...headline(operation, state),
    ...identity('Category', category === 'success' ? undefined : category),
    ...identity('Mirror', result.mirrorPath),
  ]
  for (const [label, field] of [
    ['Dry run', 'dryRun'],
    ['Executed', 'executed'],
    ['Changed', 'changed'],
  ] as const) {
    if (typeof result[field] === 'boolean')
      lines.push(...identity(label, result[field] ? 'yes' : 'no'))
  }
  lines.push(...formatCounts(result.counts), ...formatIssues(result.issues))
  const nextAction = text(result.nextAction)
  if (nextAction) lines.push('', color.bold('Next'), `  ${nextAction}`)
  return lines.join('\n') || 'Operation completed'
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

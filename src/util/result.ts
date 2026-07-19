import type { Command } from 'commander'

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
  return resolved ? [`${label}: ${resolved}`] : []
}

function formatCounts(value: unknown): string[] {
  const counts = object(value)
  if (!counts) return []
  const entries = Object.entries(counts).filter(
    ([, count]) => typeof count === 'number' || typeof count === 'string',
  )
  if (entries.length === 0) return []
  return [`Counts: ${entries.map(([name, count]) => `${name}=${String(count)}`).join(', ')}`]
}

function formatIssues(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 16).flatMap((candidate) => {
    const issue = object(candidate)
    const code = text(issue?.code)
    if (!code) return []
    const message = text(issue?.message)
    return [`Issue: ${code}${message ? ` — ${message}` : ''}`]
  })
}

function formatSoftware(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const items = value.slice(0, 100).flatMap((candidate) => {
    const item = object(candidate)
    const name = text(item?.name) ?? text(item?.id)
    if (!name) return []
    const status = text(item?.status) ?? text(item?.action) ?? 'review'
    return [`  ${name}: ${status}`]
  })
  return items.length > 0 ? ['Software:', ...items] : []
}

function formatManualDependencies(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const items = value.slice(0, 100).flatMap((candidate) => {
    if (typeof candidate === 'string') return [`  ${candidate}`]
    const item = object(candidate)
    const name = text(item?.name) ?? text(item?.id) ?? text(item?.description)
    return name ? [`  ${name}`] : []
  })
  return items.length > 0 ? ['Manual steps:', ...items] : []
}

export function formatHumanResult(value: unknown): string {
  const result = object(value)
  if (!result) return 'Operation result is unavailable'
  const repository = object(result.repository)
  const recoveryPoint = object(result.recoveryPoint)
  const staging = object(result.staging)
  const scheduler = object(result.scheduler)
  const lines = [
    ...identityLine('Operation', result.operation),
    ...identityLine('State', result.state),
    ...identityLine('Category', result.category),
    ...identityLine('Repository', result.repositoryId ?? repository?.id),
    ...identityLine(
      'Repository path',
      result.repositoryPath ?? result.repositoryLocation ?? repository?.path,
    ),
    ...identityLine('Recovery point', result.pointId ?? recoveryPoint?.id),
    ...identityLine('Staging', result.stagingPath ?? staging?.path),
  ]
  if (typeof result.dryRun === 'boolean') lines.push(`Dry run: ${result.dryRun ? 'yes' : 'no'}`)
  if (typeof result.degraded === 'boolean') {
    lines.push(`Degraded: ${result.degraded ? 'yes' : 'no'}`)
  } else if (typeof scheduler?.degraded === 'boolean') {
    lines.push(`Degraded: ${scheduler.degraded ? 'yes' : 'no'}`)
  }
  lines.push(...formatCounts(result.counts))
  lines.push(...formatSoftware(result.software))
  lines.push(...formatManualDependencies(result.manualDependencies))
  lines.push(...formatIssues(result.issues))
  const nextAction = text(result.nextAction)
  if (nextAction) lines.push(`Next: ${nextAction}`)
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

import { captureSourceOnce, wipeEntries } from './capture-tree.js'
import {
  type CaptureOptions,
  CatalogCaptureError,
  createCaptureMemoryBudget,
  validateAttempts,
} from './stable-read.js'
import type {
  CapturePlan,
  CaptureResult,
  CapturedEntry,
  CapturedSource,
  CatalogIssue,
  ResolvedSource,
} from './types.js'

const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024
const RETRYABLE_SOURCE_ERRORS = new Set([
  'SOURCE_UNSTABLE',
  'SOURCE_SCOPE_CHANGED',
  'SOURCE_TYPE_CHANGED',
  'SOURCE_UNREADABLE',
])

type CapturedWithEntries = CapturedSource & { entries: CapturedEntry[] }

function fidelityIssues(source: ResolvedSource, entries: CapturedEntry[]): CatalogIssue[] {
  return entries.flatMap((entry) =>
    (entry.fidelityIssues ?? []).map((issue) => ({
      code: issue.code,
      sourceId: source.id,
      message: `${entry.relativePath}: ${issue.message}`,
      severity: 'partial' as const,
    })),
  )
}

async function captureSource(
  source: ResolvedSource,
  options: CaptureOptions,
): Promise<CapturedWithEntries> {
  const attempts = validateAttempts(options.attempts)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let entries: CapturedEntry[] = []
    try {
      entries = await captureSourceOnce(source, options)
      const issues = fidelityIssues(source, entries)
      return {
        source,
        status: 'captured',
        entryIds: entries.map((entry) => entry.id),
        issues,
        entries,
      }
    } catch (error) {
      wipeEntries(entries, options)
      const captureError =
        error instanceof CatalogCaptureError
          ? error
          : new CatalogCaptureError('SOURCE_UNREADABLE', 'Declared source could not be captured')
      if (captureError.code === 'SOURCE_MISSING') {
        const severity = source.requirement === 'required' ? 'failure' : 'warning'
        const issue: CatalogIssue = {
          code: captureError.code,
          sourceId: source.id,
          message: captureError.message,
          severity,
        }
        return { source, status: 'missing', entryIds: [], issues: [issue], entries: [] }
      }
      if (RETRYABLE_SOURCE_ERRORS.has(captureError.code) && attempt < attempts) continue
      const severity = source.requirement === 'required' ? 'failure' : 'partial'
      const issue: CatalogIssue = {
        code: captureError.code,
        sourceId: source.id,
        message: captureError.message,
        severity,
      }
      return {
        source,
        status: captureError.code.includes('UNSTABLE') ? 'unstable' : 'failed',
        entryIds: [],
        issues: [issue],
        entries: [],
      }
    }
  }
  throw new CatalogCaptureError('SOURCE_UNSTABLE', 'Source capture retry limit was exhausted')
}

function sourceSignature(captured: CapturedWithEntries): string {
  const hardlinkTopology = (entry: CapturedEntry): string[] => {
    if (entry.type !== 'file' || !entry.identity) return []
    return captured.entries
      .filter(
        (candidate) =>
          candidate.type === 'file' &&
          candidate.identity?.device === entry.identity?.device &&
          candidate.identity?.inode === entry.identity?.inode,
      )
      .map((candidate) => candidate.relativePath)
      .sort()
  }
  return JSON.stringify({
    status: captured.status,
    entries: captured.entries.map((entry) => ({
      relativePath: entry.relativePath,
      type: entry.type,
      metadata: entry.metadata,
      fidelityIssues: entry.fidelityIssues ?? [],
      linkTarget: entry.linkTarget ?? null,
      contentHash: entry.contentHash ?? null,
      identity: entry.identity ?? null,
      hardlinkTopology: hardlinkTopology(entry),
    })),
  })
}

async function captureGroupPass(
  sources: ResolvedSource[],
  options: CaptureOptions,
): Promise<CapturedWithEntries[]> {
  const captured: CapturedWithEntries[] = []
  for (const source of sources) {
    const result = await captureSource(source, options)
    captured.push(result)
    await options.onSourceCaptured?.(source.id)
  }
  return captured
}

function wipeCaptured(captured: CapturedWithEntries[], options: CaptureOptions): void {
  for (const source of captured) wipeEntries(source.entries, options)
}

function unstableGroup(sources: ResolvedSource[], group: string): CapturedWithEntries[] {
  return sources.map((source) => ({
    source,
    status: 'unstable',
    entryIds: [],
    issues: [
      {
        code: 'CONSISTENCY_GROUP_UNSTABLE',
        sourceId: source.id,
        message: `Consistency group ${group} changed across bounded unit captures`,
        severity: source.requirement === 'required' ? 'failure' : 'partial',
      },
    ],
    entries: [],
  }))
}

async function captureConsistencyGroup(
  sources: ResolvedSource[],
  group: string,
  options: CaptureOptions,
): Promise<CapturedWithEntries[]> {
  const attempts = validateAttempts(options.attempts)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const first = await captureGroupPass(sources, options)
    if (first.some((captured) => captured.status !== 'captured')) return first
    const signatures = new Map(
      first.map((captured) => [captured.source.id, sourceSignature(captured)]),
    )
    wipeCaptured(first, options)

    const second = await captureGroupPass(sources, options)
    if (second.some((captured) => captured.status !== 'captured')) return second
    const equivalent = second.every(
      (captured) => signatures.get(captured.source.id) === sourceSignature(captured),
    )
    if (equivalent) return second
    wipeCaptured(second, options)
  }
  return unstableGroup(sources, group)
}

function preserveHardlinks(entries: CapturedEntry[], options: CaptureOptions): void {
  const firstByIdentity = new Map<string, CapturedEntry>()
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.identity) continue
    const key = `${entry.sourceId}:${entry.identity.device}:${entry.identity.inode}`
    const first = firstByIdentity.get(key)
    if (!first) {
      firstByIdentity.set(key, entry)
      continue
    }
    if (first.contentHash !== entry.contentHash) {
      throw new CatalogCaptureError(
        'SOURCE_UNSTABLE',
        'Hard-linked source content changed during capture',
      )
    }
    if (
      first.identity?.changedAtNs !== entry.identity.changedAtNs ||
      first.identity?.hardlinkCount !== entry.identity.hardlinkCount
    ) {
      throw new CatalogCaptureError(
        'SOURCE_UNSTABLE',
        'Hard-linked source topology changed during capture',
      )
    }
    entry.hardlinkTo = first.id
    if (entry.content) options.memoryBudget?.release(entry.content.length)
    entry.content?.fill(0)
    entry.content = undefined
  }
}

export async function capturePlan(
  plan: CapturePlan,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const captureOptions: CaptureOptions = {
    ...options,
    memoryBudget: createCaptureMemoryBudget(maxTotalBytes),
  }
  const capturedBySource = new Map<string, CapturedWithEntries>()
  const grouped = new Map<string, ResolvedSource[]>()
  for (const source of plan.sources) {
    if (!source.consistencyGroup) {
      capturedBySource.set(source.id, await captureSource(source, captureOptions))
      continue
    }
    const group = grouped.get(source.consistencyGroup) ?? []
    group.push(source)
    grouped.set(source.consistencyGroup, group)
  }
  for (const [name, sources] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const captured of await captureConsistencyGroup(sources, name, captureOptions)) {
      capturedBySource.set(captured.source.id, captured)
    }
  }

  const capturedSources = plan.sources.map((source) => {
    const captured = capturedBySource.get(source.id)
    if (!captured) throw new CatalogCaptureError('SOURCE_UNREADABLE', 'Source capture was omitted')
    return captured
  })
  const entries = capturedSources.flatMap((captured) => captured.entries)
  entries.sort((left, right) => left.id.localeCompare(right.id))
  preserveHardlinks(entries, captureOptions)

  const consistencyGroupsFailed = [
    ...new Set(
      capturedSources
        .filter((captured) => captured.status !== 'captured')
        .flatMap((captured) => captured.source.consistencyGroup ?? []),
    ),
  ].sort()
  const groupIssues: CatalogIssue[] = consistencyGroupsFailed.map((group) => ({
    code: 'CONSISTENCY_GROUP_INCOMPLETE',
    sourceId: group,
    message: `Consistency group ${group} has an incomplete or unstable member`,
    severity: 'partial',
  }))
  const sources: CapturedSource[] = capturedSources.map(
    ({ entries: _entries, ...source }) => source,
  )
  const issues = [...sources.flatMap((source) => source.issues), ...groupIssues]
  return {
    sources,
    entries,
    issues,
    requiredFailed: sources.some(
      (source) => source.source.requirement === 'required' && source.status !== 'captured',
    ),
    consistencyGroupsFailed,
  }
}

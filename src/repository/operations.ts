import { randomUUID } from 'node:crypto'
import { lstat, opendir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { assertRepositoryWriteAuthorized } from './authorization.js'
import { RepositoryError } from './errors.js'
import { readBoundedRegularFile, syncDirectory, writeDurableExclusiveFile } from './io.js'
import type { RepositoryHandle } from './types.js'

export type OperationState = 'success' | 'warning' | 'partial' | 'degraded' | 'failure'
export type OperationCategory =
  | 'success'
  | 'warning'
  | 'partial'
  | 'configuration'
  | 'authentication'
  | 'lock'
  | 'source'
  | 'destination'
  | 'integrity'
  | 'unsupported'
  | 'cancelled'
  | 'internal'
export type VerificationScope = 'structural' | 'content'

export interface OperationCounts {
  filesConsidered: number
  filesWritten: number
  filesSkipped: number
  filesFailed: number
  bytesRead: number
  bytesWritten: number
}

export interface ClassifiedIssue {
  code: string
  category: Exclude<OperationCategory, 'success'>
  message: string
  nextAction?: string
}

export interface OperationResult {
  operation: string
  state: OperationState
  category: OperationCategory
  repositoryId?: string
  pointId?: string
  startedAt: string
  endedAt: string
  counts: OperationCounts
  verificationScope?: VerificationScope
  issues: ClassifiedIssue[]
}

export interface CreateOperationResultInput extends Omit<OperationResult, 'counts' | 'issues'> {
  counts?: Partial<OperationCounts>
  issues?: ClassifiedIssue[]
}

const SECRET_PREFIX = 'restore-recovery-v1:'
const MAX_HISTORY_ENTRY_BYTES = 1024 * 1024
export const MAX_OPERATION_HISTORY_ENTRIES = 100
export const MAX_OPERATION_PENDING_ENTRIES = 16
const OPERATION_PENDING_NAME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-zA-Z0-9_-]{1,100}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json\.pending$/i
const RESULT_KEYS = new Set([
  'operation',
  'state',
  'category',
  'repositoryId',
  'pointId',
  'startedAt',
  'endedAt',
  'counts',
  'verificationScope',
  'issues',
])
const COUNT_KEYS = new Set([
  'filesConsidered',
  'filesWritten',
  'filesSkipped',
  'filesFailed',
  'bytesRead',
  'bytesWritten',
])
const ISSUE_KEYS = new Set(['code', 'category', 'message', 'nextAction'])
const OPERATION_STATES = new Set<OperationState>([
  'success',
  'warning',
  'partial',
  'degraded',
  'failure',
])
const OPERATION_CATEGORIES = new Set<OperationCategory>([
  'success',
  'warning',
  'partial',
  'configuration',
  'authentication',
  'lock',
  'source',
  'destination',
  'integrity',
  'unsupported',
  'cancelled',
  'internal',
])

const EMPTY_COUNTS: OperationCounts = {
  filesConsidered: 0,
  filesWritten: 0,
  filesSkipped: 0,
  filesFailed: 0,
  bytesRead: 0,
  bytesWritten: 0,
}

function invalidResult(): never {
  throw new RepositoryError(
    'configuration',
    'INVALID_OPERATION_RESULT',
    'Operation result is invalid',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function safeString(value: unknown, maxLength: number, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength ||
    value.includes(SECRET_PREFIX) ||
    value.includes('\0')
  ) {
    return invalidResult()
  }
  return value
}

function safeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalidResult()
  return value as number
}

function parseCounts(value: unknown): OperationCounts {
  if (value === undefined) return { ...EMPTY_COUNTS }
  if (!isRecord(value) || !hasOnlyKeys(value, COUNT_KEYS)) return invalidResult()

  const counts = {
    filesConsidered: value.filesConsidered === undefined ? 0 : safeCount(value.filesConsidered),
    filesWritten: value.filesWritten === undefined ? 0 : safeCount(value.filesWritten),
    filesSkipped: value.filesSkipped === undefined ? 0 : safeCount(value.filesSkipped),
    filesFailed: value.filesFailed === undefined ? 0 : safeCount(value.filesFailed),
    bytesRead: value.bytesRead === undefined ? 0 : safeCount(value.bytesRead),
    bytesWritten: value.bytesWritten === undefined ? 0 : safeCount(value.bytesWritten),
  }
  if (counts.filesWritten + counts.filesSkipped + counts.filesFailed > counts.filesConsidered) {
    return invalidResult()
  }
  return counts
}

function parseIssues(value: unknown): ClassifiedIssue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return invalidResult()

  return value.map((issue) => {
    if (!isRecord(issue) || !hasOnlyKeys(issue, ISSUE_KEYS)) return invalidResult()
    const category = issue.category
    if (
      typeof category !== 'string' ||
      !OPERATION_CATEGORIES.has(category as OperationCategory) ||
      category === 'success'
    ) {
      return invalidResult()
    }
    return {
      code: safeString(issue.code, 100),
      category: category as ClassifiedIssue['category'],
      message: safeString(issue.message, 2000),
      ...(issue.nextAction === undefined ? {} : { nextAction: safeString(issue.nextAction, 2000) }),
    }
  })
}

function validateSemantics(
  state: OperationState,
  category: OperationCategory,
  counts: OperationCounts,
  issues: ClassifiedIssue[],
): void {
  if (state === 'success') {
    if (category !== 'success' || counts.filesFailed !== 0 || issues.length !== 0) invalidResult()
    return
  }

  if (category === 'success' || issues.length === 0) invalidResult()
  if (state === 'warning' && category !== 'warning') invalidResult()
  if (state === 'partial' && category !== 'partial') invalidResult()
  if (state === 'degraded' && category === 'partial') invalidResult()
  if (state === 'failure' && (category === 'warning' || category === 'partial')) invalidResult()
  if (!issues.some((issue) => issue.category === category)) invalidResult()
}

export function createOperationResult(input: CreateOperationResultInput): OperationResult {
  if (!isRecord(input) || !hasOnlyKeys(input, RESULT_KEYS)) return invalidResult()

  const operation = safeString(input.operation, 100)
  const state = input.state
  const category = input.category
  if (
    typeof state !== 'string' ||
    !OPERATION_STATES.has(state as OperationState) ||
    typeof category !== 'string' ||
    !OPERATION_CATEGORIES.has(category as OperationCategory)
  ) {
    return invalidResult()
  }

  const startedAtInput = safeString(input.startedAt, 100)
  const endedAtInput = safeString(input.endedAt, 100)
  const startedAt = new Date(startedAtInput)
  const endedAt = new Date(endedAtInput)
  if (
    !Number.isFinite(startedAt.getTime()) ||
    !Number.isFinite(endedAt.getTime()) ||
    endedAt.getTime() < startedAt.getTime()
  ) {
    return invalidResult()
  }

  const counts = parseCounts(input.counts)
  const issues = parseIssues(input.issues)
  validateSemantics(state as OperationState, category as OperationCategory, counts, issues)

  let verificationScope: VerificationScope | undefined
  if (input.verificationScope !== undefined) {
    if (input.verificationScope !== 'structural' && input.verificationScope !== 'content') {
      return invalidResult()
    }
    verificationScope = input.verificationScope
  }

  const result: OperationResult = {
    operation,
    state: state as OperationState,
    category: category as OperationCategory,
    ...(input.repositoryId === undefined
      ? {}
      : { repositoryId: safeString(input.repositoryId, 256) }),
    ...(input.pointId === undefined ? {} : { pointId: safeString(input.pointId, 256) }),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    counts,
    ...(verificationScope ? { verificationScope } : {}),
    issues,
  }
  if (JSON.stringify(result).includes(SECRET_PREFIX)) return invalidResult()
  return result
}

function historyName(result: OperationResult): string {
  return `${result.endedAt.replaceAll(':', '-')}-${result.operation.replace(/[^a-zA-Z0-9_-]/g, '_')}-${randomUUID()}.json`
}

interface DirectoryIdentity {
  deviceId: bigint
  inode: bigint
}

function invalidHistory(code = 'INVALID_OPERATION_HISTORY'): RepositoryError {
  return new RepositoryError(
    'integrity',
    code,
    code === 'OPERATION_HISTORY_LIMIT_EXCEEDED'
      ? 'Operation history exceeds the supported entry limit'
      : 'Operation history is invalid or unsafe',
  )
}

async function captureOperationsDirectory(path: string): Promise<DirectoryIdentity> {
  try {
    const directory = await lstat(path, { bigint: true })
    if (!directory.isDirectory()) throw new Error('unsafe operations directory')
    return { deviceId: directory.dev, inode: directory.ino }
  } catch {
    throw invalidHistory()
  }
}

async function assertOperationsDirectory(path: string, expected: DirectoryIdentity): Promise<void> {
  const actual = await captureOperationsDirectory(path)
  if (actual.deviceId !== expected.deviceId || actual.inode !== expected.inode) {
    throw invalidHistory()
  }
}

interface OperationDirectoryEntries {
  final: string[]
  pending: string[]
}

async function readOperationEntries(
  path: string,
  identity: DirectoryIdentity,
): Promise<OperationDirectoryEntries> {
  await assertOperationsDirectory(path, identity)
  let directory: Awaited<ReturnType<typeof opendir>>
  try {
    directory = await opendir(path)
  } catch {
    throw invalidHistory()
  }

  const entries: OperationDirectoryEntries = { final: [], pending: [] }
  try {
    for await (const entry of directory) {
      await assertOperationsDirectory(path, identity)
      if (!entry.isFile()) throw invalidHistory()
      if (entry.name.endsWith('.json')) {
        if (entries.final.length >= MAX_OPERATION_HISTORY_ENTRIES) {
          throw invalidHistory('OPERATION_HISTORY_LIMIT_EXCEEDED')
        }
        entries.final.push(entry.name)
        continue
      }
      if (OPERATION_PENDING_NAME_PATTERN.test(entry.name)) {
        if (entries.pending.length >= MAX_OPERATION_PENDING_ENTRIES) {
          throw invalidHistory('OPERATION_HISTORY_PENDING_LIMIT_EXCEEDED')
        }
        entries.pending.push(entry.name)
        continue
      }
      throw invalidHistory()
    }
  } catch (error) {
    if (error instanceof RepositoryError) throw error
    throw invalidHistory()
  }
  await assertOperationsDirectory(path, identity)
  return entries
}

async function removePendingEntries(
  path: string,
  entries: readonly string[],
  identity: DirectoryIdentity,
): Promise<void> {
  for (const entry of entries) {
    const pendingPath = join(path, entry)
    await assertOperationsDirectory(path, identity)
    let pendingStat: Awaited<ReturnType<typeof lstat>>
    try {
      pendingStat = await lstat(pendingPath)
    } catch {
      throw invalidHistory()
    }
    if (!pendingStat.isFile() || !OPERATION_PENDING_NAME_PATTERN.test(entry)) {
      throw invalidHistory()
    }
    await assertOperationsDirectory(path, identity)
    try {
      await unlink(pendingPath)
    } catch {
      throw invalidHistory()
    }
    await assertOperationsDirectory(path, identity)
  }
  if (entries.length > 0) {
    await syncDirectory(path)
    await assertOperationsDirectory(path, identity)
  }
}

async function removeIfOriginalDirectory(
  path: string,
  file: string,
  identity: DirectoryIdentity,
): Promise<void> {
  try {
    await assertOperationsDirectory(path, identity)
    await unlink(file)
    await assertOperationsDirectory(path, identity)
  } catch {}
}

export async function recordOperationResult(
  repository: RepositoryHandle,
  result: OperationResult,
  maxEntries = 100,
): Promise<string> {
  assertRepositoryWriteAuthorized(repository)
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > MAX_OPERATION_HISTORY_ENTRIES
  ) {
    throw new RepositoryError('configuration', 'INVALID_HISTORY_LIMIT', 'History limit is invalid')
  }

  const normalized = createOperationResult(result)
  if (normalized.repositoryId && normalized.repositoryId !== repository.descriptor.repositoryId) {
    throw new RepositoryError(
      'configuration',
      'OPERATION_REPOSITORY_MISMATCH',
      'Operation result belongs to a different repository',
    )
  }
  const name = historyName(normalized)
  const finalPath = join(repository.layout.operations, name)
  const temporaryPath = `${finalPath}.pending`
  const directoryIdentity = await captureOperationsDirectory(repository.layout.operations)
  const existingEntries = await readOperationEntries(
    repository.layout.operations,
    directoryIdentity,
  )
  await removePendingEntries(
    repository.layout.operations,
    existingEntries.pending,
    directoryIdentity,
  )
  try {
    // Node exposes no openat/renameat API. Rechecking the no-symlink directory's dev/ino around
    // every path syscall is the strongest stdlib-only guard and fails closed when a swap is seen.
    await assertOperationsDirectory(repository.layout.operations, directoryIdentity)
    await writeDurableExclusiveFile(temporaryPath, `${JSON.stringify(normalized)}\n`)
    await assertOperationsDirectory(repository.layout.operations, directoryIdentity)
    await rename(temporaryPath, finalPath)
    await assertOperationsDirectory(repository.layout.operations, directoryIdentity)
    await syncDirectory(repository.layout.operations)
  } catch (error) {
    await removeIfOriginalDirectory(repository.layout.operations, temporaryPath, directoryIdentity)
    if (error instanceof RepositoryError) throw error
    throw invalidHistory()
  }

  const entries = [...existingEntries.final, name].sort()
  for (const oldEntry of entries.slice(0, Math.max(0, entries.length - maxEntries))) {
    await assertOperationsDirectory(repository.layout.operations, directoryIdentity)
    await unlink(join(repository.layout.operations, oldEntry))
    await assertOperationsDirectory(repository.layout.operations, directoryIdentity)
  }
  await syncDirectory(repository.layout.operations)
  await assertOperationsDirectory(repository.layout.operations, directoryIdentity)
  return finalPath
}

export async function listOperationResults(
  repository: RepositoryHandle,
): Promise<OperationResult[]> {
  const directoryIdentity = await captureOperationsDirectory(repository.layout.operations)
  const entries = (
    await readOperationEntries(repository.layout.operations, directoryIdentity)
  ).final
    .sort()
    .reverse()

  const results: OperationResult[] = []
  for (const entry of entries) {
    try {
      await assertOperationsDirectory(repository.layout.operations, directoryIdentity)
      const content = await readBoundedRegularFile(
        join(repository.layout.operations, entry),
        MAX_HISTORY_ENTRY_BYTES,
      )
      await assertOperationsDirectory(repository.layout.operations, directoryIdentity)
      results.push(createOperationResult(JSON.parse(content.toString('utf8'))))
    } catch (error) {
      if (error instanceof RepositoryError && error.code === 'OPERATION_HISTORY_LIMIT_EXCEEDED') {
        throw error
      }
      throw invalidHistory()
    }
  }
  await assertOperationsDirectory(repository.layout.operations, directoryIdentity)
  return results
}

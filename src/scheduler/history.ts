import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { OperationCategory, OperationState } from '../repository/index.js'
import {
  SCHEDULER_HISTORY_LIMIT,
  SCHEDULER_HISTORY_VERSION,
  type SchedulerNotificationState,
  type SchedulerRunRecord,
} from './types.js'

const MAX_HISTORY_FILE_BYTES = 64 * 1024
const MAX_DIRECTORY_ENTRIES = 256
const HISTORY_NAME =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/
const PENDING_NAME =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json\.pending$/
const RECORD_KEYS = new Set([
  'schemaVersion',
  'operation',
  'state',
  'category',
  'repositoryId',
  'pointId',
  'startedAt',
  'endedAt',
  'durationMs',
  'healthyPublished',
  'latestHealthyAt',
  'degraded',
  'issueCode',
  'notification',
])
const STATES = new Set<OperationState>(['success', 'warning', 'partial', 'degraded', 'failure'])
const CATEGORIES = new Set<OperationCategory>([
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
const NOTIFICATION_STATES = new Set<SchedulerNotificationState>(['not-required', 'sent', 'failed'])

interface DirectoryIdentity {
  device: bigint
  inode: bigint
}

export function getSchedulerStateDirectory(home = homedir()): string {
  return resolve(home, '.config', 'restore', 'scheduler')
}

export function getSchedulerHistoryDirectory(home = homedir()): string {
  return join(getSchedulerStateDirectory(home), 'history')
}

function invalidHistory(): Error {
  return new Error('Scheduler history is malformed or unsafe')
}

function safeString(value: unknown, max: number, nullable = false): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) {
    throw invalidHistory()
  }
  return value
}

function safeDate(value: unknown, nullable = false): string | null {
  const text = safeString(value, 100, nullable)
  if (text === null) return null
  const parsed = new Date(text)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) throw invalidHistory()
  return text
}

export function validateSchedulerRunRecord(value: unknown): SchedulerRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidHistory()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !RECORD_KEYS.has(key))) throw invalidHistory()
  if (input.schemaVersion !== SCHEDULER_HISTORY_VERSION || input.operation !== 'scheduled-backup') {
    throw invalidHistory()
  }
  if (typeof input.state !== 'string' || !STATES.has(input.state as OperationState)) {
    throw invalidHistory()
  }
  if (typeof input.category !== 'string' || !CATEGORIES.has(input.category as OperationCategory)) {
    throw invalidHistory()
  }
  if (
    typeof input.notification !== 'string' ||
    !NOTIFICATION_STATES.has(input.notification as SchedulerNotificationState)
  ) {
    throw invalidHistory()
  }
  if (
    typeof input.durationMs !== 'number' ||
    !Number.isSafeInteger(input.durationMs) ||
    input.durationMs < 0 ||
    typeof input.healthyPublished !== 'boolean' ||
    typeof input.degraded !== 'boolean'
  ) {
    throw invalidHistory()
  }
  const startedAt = safeDate(input.startedAt) as string
  const endedAt = safeDate(input.endedAt) as string
  if (
    Date.parse(endedAt) < Date.parse(startedAt) ||
    input.durationMs !== Date.parse(endedAt) - Date.parse(startedAt)
  ) {
    throw invalidHistory()
  }
  const state = input.state as OperationState
  const category = input.category as OperationCategory
  if (
    (state === 'success' && category !== 'success') ||
    (state !== 'success' && category === 'success') ||
    (state === 'warning' && category !== 'warning') ||
    (state === 'partial' && category !== 'partial') ||
    (state === 'degraded' && category === 'partial') ||
    (state === 'failure' && (category === 'warning' || category === 'partial'))
  ) {
    throw invalidHistory()
  }
  const repositoryId = safeString(input.repositoryId, 256, true)
  const pointId = safeString(input.pointId, 256, true)
  const latestHealthyAt = safeDate(input.latestHealthyAt, true)
  if (input.healthyPublished && (!pointId || !latestHealthyAt)) throw invalidHistory()
  return {
    schemaVersion: SCHEDULER_HISTORY_VERSION,
    operation: 'scheduled-backup',
    state,
    category,
    repositoryId,
    pointId,
    startedAt,
    endedAt,
    durationMs: input.durationMs,
    healthyPublished: input.healthyPublished,
    latestHealthyAt,
    degraded: input.degraded,
    issueCode: safeString(input.issueCode, 100, true),
    notification: input.notification as SchedulerNotificationState,
  }
}

async function ensurePrivateDirectory(path: string): Promise<DirectoryIdentity> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat({ bigint: true })
    if (!stat.isDirectory()) throw invalidHistory()
    await handle.chmod(0o700)
    const verified = await handle.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (
      !verified.isDirectory() ||
      !named.isDirectory() ||
      named.isSymbolicLink() ||
      verified.dev !== stat.dev ||
      verified.ino !== stat.ino ||
      named.dev !== stat.dev ||
      named.ino !== stat.ino
    ) {
      throw invalidHistory()
    }
    return { device: verified.dev, inode: verified.ino }
  } finally {
    await handle.close()
  }
}

async function ensureHistoryDirectory(path: string): Promise<DirectoryIdentity> {
  await ensurePrivateDirectory(dirname(path))
  return ensurePrivateDirectory(path)
}

async function assertDirectory(path: string, identity: DirectoryIdentity): Promise<void> {
  const stat = await lstat(path, { bigint: true })
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== identity.device ||
    stat.ino !== identity.inode
  ) {
    throw invalidHistory()
  }
}

async function readBoundedFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_HISTORY_FILE_BYTES) {
      throw invalidHistory()
    }
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) throw invalidHistory()
      offset += bytesRead
    }
    const after = await handle.stat()
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) {
      throw invalidHistory()
    }
    return buffer
  } finally {
    await handle.close()
  }
}

async function listNames(path: string, identity: DirectoryIdentity): Promise<string[]> {
  await assertDirectory(path, identity)
  const names = await readdir(path)
  if (names.length > MAX_DIRECTORY_ENTRIES) throw invalidHistory()
  for (const name of names) {
    if (!HISTORY_NAME.test(name) && !PENDING_NAME.test(name)) throw invalidHistory()
  }
  await assertDirectory(path, identity)
  return names
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function listSchedulerHistory(
  historyDirectory = getSchedulerHistoryDirectory(),
): Promise<SchedulerRunRecord[]> {
  let identity: DirectoryIdentity
  try {
    identity = await ensureHistoryDirectory(historyDirectory)
  } catch {
    throw invalidHistory()
  }
  const names = (await listNames(historyDirectory, identity))
    .filter((name) => HISTORY_NAME.test(name))
    .sort()
    .reverse()
  const records: SchedulerRunRecord[] = []
  for (const name of names) {
    await assertDirectory(historyDirectory, identity)
    const buffer = await readBoundedFile(join(historyDirectory, name))
    try {
      records.push(validateSchedulerRunRecord(JSON.parse(buffer.toString('utf8'))))
    } catch {
      throw invalidHistory()
    } finally {
      buffer.fill(0)
    }
  }
  await assertDirectory(historyDirectory, identity)
  return records
}

export async function recordSchedulerRun(
  record: SchedulerRunRecord,
  options: { historyDirectory?: string; limit?: number; id?: string } = {},
): Promise<string> {
  const normalized = validateSchedulerRunRecord(record)
  const limit = options.limit ?? SCHEDULER_HISTORY_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SCHEDULER_HISTORY_LIMIT) {
    throw new Error('Scheduler history limit is invalid')
  }
  const historyDirectory = options.historyDirectory ?? getSchedulerHistoryDirectory()
  const identity = await ensureHistoryDirectory(historyDirectory)
  const id = options.id ?? randomUUID()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new Error('Scheduler history ID is invalid')
  }
  const timestamp = normalized.endedAt.replaceAll(':', '-')
  const name = `${timestamp}-${id}.json`
  if (basename(name) !== name || !HISTORY_NAME.test(name)) throw invalidHistory()
  const finalPath = join(historyDirectory, name)
  const pendingPath = `${finalPath}.pending`
  const content = Buffer.from(`${JSON.stringify(normalized)}\n`)
  if (content.length > MAX_HISTORY_FILE_BYTES) throw invalidHistory()
  const handle = await open(
    pendingPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    let offset = 0
    while (offset < content.length) {
      const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset)
      if (bytesWritten === 0) throw invalidHistory()
      offset += bytesWritten
    }
    await handle.sync()
  } finally {
    content.fill(0)
    await handle.close()
  }
  await assertDirectory(historyDirectory, identity)
  await rename(pendingPath, finalPath)
  await assertDirectory(historyDirectory, identity)
  await syncDirectory(historyDirectory)

  const names = await listNames(historyDirectory, identity)
  for (const pending of names.filter((entry) => PENDING_NAME.test(entry))) {
    await unlink(join(historyDirectory, pending))
    await assertDirectory(historyDirectory, identity)
  }
  const finalNames = names.filter((entry) => HISTORY_NAME.test(entry)).sort()
  for (const oldName of finalNames.slice(0, Math.max(0, finalNames.length - limit))) {
    await unlink(join(historyDirectory, oldName))
    await assertDirectory(historyDirectory, identity)
  }
  await syncDirectory(historyDirectory)
  await assertDirectory(historyDirectory, identity)
  return finalPath
}

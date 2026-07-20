import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { assertRepositoryWriteAuthorized } from './authorization.js'
import { RepositoryError, isNodeError } from './errors.js'
import { readBoundedRegularFile, syncDirectory, writeDurableExclusiveFile } from './io.js'
import type { RepositoryHandle } from './types.js'

const LOCK_FORMAT_VERSION = 1 as const
const MAX_LOCK_METADATA_BYTES = 64 * 1024
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000

export interface RepositoryLockMetadata {
  formatVersion: typeof LOCK_FORMAT_VERSION
  lockId: string
  owner: {
    pid: number
    hostname: string
    instanceId: string
  }
  operation: string
  startedAt: string
}

export type RepositoryLockInspection =
  | { state: 'unlocked' }
  | {
      state: 'locked'
      metadata: RepositoryLockMetadata | null
      ageMs: number | null
      ownerAlive: boolean | null
      staleCandidate: boolean
    }

export interface RepositoryLock {
  metadata: RepositoryLockMetadata
  release(): Promise<void>
}

interface RepositoryLockCapability {
  brand: symbol
  repository: {
    path: string
    repositoryId: string
    device: bigint
    inode: bigint
  }
  lockDirectory: {
    path: string
    device: bigint
    inode: bigint
  }
  metadataPath: string
  metadataIdentity: BigIntStats
  metadata: RepositoryLockMetadata
  released: boolean
}

const REPOSITORY_LOCK_BRAND = Symbol('RepositoryLockCapability')
const repositoryLockCapabilities = new WeakMap<RepositoryLock, RepositoryLockCapability>()

export interface ConfirmedRepositoryLockClearOptions {
  confirm: boolean
  expectedLockId: string
  expectedOwner: RepositoryLockMetadata['owner']
}

export class RepositoryLockError extends RepositoryError {
  readonly inspection: RepositoryLockInspection

  constructor(message: string, inspection: RepositoryLockInspection) {
    super('lock', 'REPOSITORY_LOCKED', message)
    this.name = 'RepositoryLockError'
    this.inspection = inspection
  }
}

function parseLockMetadata(value: unknown): RepositoryLockMetadata | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<RepositoryLockMetadata>
  if (
    candidate.formatVersion !== LOCK_FORMAT_VERSION ||
    typeof candidate.lockId !== 'string' ||
    !candidate.owner ||
    !Number.isSafeInteger(candidate.owner.pid) ||
    (candidate.owner.pid ?? 0) <= 0 ||
    typeof candidate.owner.hostname !== 'string' ||
    typeof candidate.owner.instanceId !== 'string' ||
    typeof candidate.operation !== 'string' ||
    typeof candidate.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.startedAt))
  ) {
    return null
  }
  return candidate as RepositoryLockMetadata
}

async function readLockMetadata(metadataPath: string): Promise<RepositoryLockMetadata | null> {
  try {
    const content = await readBoundedRegularFile(metadataPath, MAX_LOCK_METADATA_BYTES)
    return parseLockMetadata(JSON.parse(content.toString('utf8')))
  } catch {
    return null
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  // Sync providers may change ctime when attaching xattrs without replacing or editing the file.
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs
  )
}

function lockMetadataMatches(
  actual: RepositoryLockMetadata | null,
  expected: RepositoryLockMetadata,
): boolean {
  return (
    actual !== null &&
    actual.formatVersion === expected.formatVersion &&
    actual.lockId === expected.lockId &&
    actual.owner.pid === expected.owner.pid &&
    actual.owner.hostname === expected.owner.hostname &&
    actual.owner.instanceId === expected.owner.instanceId &&
    actual.operation === expected.operation &&
    actual.startedAt === expected.startedAt
  )
}

async function assertCapabilityFilesystemOwnership(
  capability: RepositoryLockCapability,
): Promise<void> {
  let repository: BigIntStats
  let lockDirectory: BigIntStats
  let metadataHandle: Awaited<ReturnType<typeof open>>
  try {
    repository = await lstat(capability.repository.path, { bigint: true })
    lockDirectory = await lstat(capability.lockDirectory.path, { bigint: true })
    metadataHandle = await open(
      capability.metadataPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch {
    throw new RepositoryError(
      'lock',
      'LOCK_OWNERSHIP_CHANGED',
      'Repository lock ownership changed; delegated access was rejected',
    )
  }
  try {
    const heldBefore = await metadataHandle.stat({ bigint: true })
    const namedBefore = await lstat(capability.metadataPath, { bigint: true })
    if (
      !repository.isDirectory() ||
      repository.isSymbolicLink() ||
      repository.dev !== capability.repository.device ||
      repository.ino !== capability.repository.inode ||
      !lockDirectory.isDirectory() ||
      lockDirectory.isSymbolicLink() ||
      lockDirectory.dev !== capability.lockDirectory.device ||
      lockDirectory.ino !== capability.lockDirectory.inode ||
      !sameFileIdentity(heldBefore, capability.metadataIdentity) ||
      !sameFileIdentity(namedBefore, capability.metadataIdentity) ||
      heldBefore.size > BigInt(MAX_LOCK_METADATA_BYTES)
    ) {
      throw new Error('lock identity mismatch')
    }
    const content = Buffer.alloc(Number(heldBefore.size))
    try {
      let offset = 0
      while (offset < content.length) {
        const { bytesRead } = await metadataHandle.read(
          content,
          offset,
          content.length - offset,
          null,
        )
        if (bytesRead < 1) throw new Error('short lock metadata read')
        offset += bytesRead
      }
      const heldAfter = await metadataHandle.stat({ bigint: true })
      const namedAfter = await lstat(capability.metadataPath, { bigint: true })
      if (
        !sameFileIdentity(heldAfter, capability.metadataIdentity) ||
        !sameFileIdentity(namedAfter, capability.metadataIdentity) ||
        !lockMetadataMatches(
          parseLockMetadata(JSON.parse(content.toString('utf8'))),
          capability.metadata,
        )
      ) {
        throw new Error('lock metadata mismatch')
      }
    } finally {
      content.fill(0)
    }
  } catch {
    throw new RepositoryError(
      'lock',
      'LOCK_OWNERSHIP_CHANGED',
      'Repository lock ownership changed; delegated access was rejected',
    )
  } finally {
    await metadataHandle.close().catch(() => undefined)
  }
}

async function validateRepositoryLockOwnership(
  repository: RepositoryHandle,
  lock: RepositoryLock,
  requireAuthorizedHandle: boolean,
): Promise<void> {
  if (requireAuthorizedHandle) assertRepositoryWriteAuthorized(repository)
  const capability = repositoryLockCapabilities.get(lock)
  if (!capability || capability.brand !== REPOSITORY_LOCK_BRAND) {
    throw new RepositoryError(
      'lock',
      'LOCK_CAPABILITY_INVALID',
      'Repository lock capability was not issued by this process',
    )
  }
  if (capability.released) {
    throw new RepositoryError(
      'lock',
      'LOCK_CAPABILITY_RELEASED',
      'Repository lock capability has already been released',
    )
  }
  if (
    resolve(repository.path) !== capability.repository.path ||
    repository.descriptor.repositoryId !== capability.repository.repositoryId
  ) {
    throw new RepositoryError(
      'lock',
      'LOCK_CAPABILITY_REPOSITORY_MISMATCH',
      'Repository lock capability belongs to a different repository',
    )
  }
  await assertCapabilityFilesystemOwnership(capability)
}

export async function assertRepositoryLockOwnership(
  repository: RepositoryHandle,
  lock: RepositoryLock,
): Promise<void> {
  await validateRepositoryLockOwnership(repository, lock, true)
}

function isOwnerAlive(metadata: RepositoryLockMetadata): boolean | null {
  if (metadata.owner.hostname !== hostname()) return null
  try {
    process.kill(metadata.owner.pid, 0)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') return false
    return true
  }
}

function inspectMetadata(
  metadata: RepositoryLockMetadata,
  options: { now?: Date; staleAfterMs?: number },
): Extract<RepositoryLockInspection, { state: 'locked' }> {
  const now = options.now ?? new Date()
  const ageMs = Math.max(0, now.getTime() - Date.parse(metadata.startedAt))
  const ownerAlive = isOwnerAlive(metadata)
  return {
    state: 'locked',
    metadata,
    ageMs,
    ownerAlive,
    staleCandidate:
      ownerAlive === false && ageMs >= (options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
  }
}

export async function inspectRepositoryLock(
  repository: RepositoryHandle,
  options: { now?: Date; staleAfterMs?: number } = {},
): Promise<RepositoryLockInspection> {
  try {
    if (!(await lstat(repository.layout.locks)).isDirectory()) throw new Error('unsafe locks')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        state: 'locked',
        metadata: null,
        ageMs: null,
        ownerAlive: null,
        staleCandidate: false,
      }
    }
    throw new RepositoryError('lock', 'LOCK_INSPECTION_FAILED', 'Lock directory is invalid')
  }

  try {
    const lockStat = await lstat(repository.layout.repositoryLock)
    if (!lockStat.isDirectory()) throw new Error('unsafe lock')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { state: 'unlocked' }
    throw new RepositoryError(
      'lock',
      'LOCK_INSPECTION_FAILED',
      'Repository lock could not be inspected',
    )
  }

  const metadata = await readLockMetadata(join(repository.layout.repositoryLock, 'owner.json'))
  if (!metadata) {
    return {
      state: 'locked',
      metadata: null,
      ageMs: null,
      ownerAlive: null,
      staleCandidate: false,
    }
  }
  return inspectMetadata(metadata, options)
}

export async function acquireRepositoryLock(
  repository: RepositoryHandle,
  operation: string,
  options: { now?: Date; instanceId?: string } = {},
): Promise<RepositoryLock> {
  assertRepositoryWriteAuthorized(repository)
  if (!operation || operation.length > 100) {
    throw new RepositoryError('configuration', 'INVALID_OPERATION', 'Lock operation is invalid')
  }

  const metadata: RepositoryLockMetadata = {
    formatVersion: LOCK_FORMAT_VERSION,
    lockId: randomUUID(),
    owner: {
      pid: process.pid,
      hostname: hostname(),
      instanceId: options.instanceId ?? randomUUID(),
    },
    operation,
    startedAt: (options.now ?? new Date()).toISOString(),
  }

  try {
    await mkdir(repository.layout.repositoryLock, { mode: 0o700 })
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new RepositoryLockError(
        'Repository is locked; inspect the owner before explicitly clearing a stale lock',
        await inspectRepositoryLock(repository),
      )
    }
    throw new RepositoryError(
      'lock',
      'LOCK_ACQUIRE_FAILED',
      'Repository lock could not be acquired',
    )
  }

  const metadataPath = join(repository.layout.repositoryLock, 'owner.json')
  try {
    await writeDurableExclusiveFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
    await syncDirectory(repository.layout.repositoryLock)
  } catch {
    await unlink(metadataPath).catch(() => {})
    await rmdir(repository.layout.repositoryLock).catch(() => {})
    throw new RepositoryError(
      'lock',
      'LOCK_ACQUIRE_FAILED',
      'Repository lock could not be acquired',
    )
  }

  let repositoryIdentity: BigIntStats
  let lockDirectoryIdentity: BigIntStats
  let metadataIdentity: BigIntStats
  try {
    repositoryIdentity = await lstat(repository.path, { bigint: true })
    lockDirectoryIdentity = await lstat(repository.layout.repositoryLock, { bigint: true })
    metadataIdentity = await lstat(metadataPath, { bigint: true })
    if (
      !repositoryIdentity.isDirectory() ||
      repositoryIdentity.isSymbolicLink() ||
      !lockDirectoryIdentity.isDirectory() ||
      lockDirectoryIdentity.isSymbolicLink() ||
      !metadataIdentity.isFile() ||
      metadataIdentity.isSymbolicLink()
    ) {
      throw new Error('unsafe lock capability identity')
    }
  } catch {
    await unlink(metadataPath).catch(() => undefined)
    await rmdir(repository.layout.repositoryLock).catch(() => undefined)
    throw new RepositoryError(
      'lock',
      'LOCK_ACQUIRE_FAILED',
      'Repository lock capability identity could not be established',
    )
  }

  const lock: RepositoryLock = {
    metadata,
    async release() {
      const capability = repositoryLockCapabilities.get(lock)
      if (capability?.released) return
      await validateRepositoryLockOwnership(repository, lock, false)

      try {
        await unlink(metadataPath)
        await rmdir(repository.layout.repositoryLock)
        await syncDirectory(repository.layout.locks)
        if (capability) capability.released = true
      } catch {
        throw new RepositoryError(
          'lock',
          'LOCK_RELEASE_FAILED',
          'Repository lock could not be released',
        )
      }
    },
  }
  repositoryLockCapabilities.set(lock, {
    brand: REPOSITORY_LOCK_BRAND,
    repository: {
      path: resolve(repository.path),
      repositoryId: repository.descriptor.repositoryId,
      device: repositoryIdentity.dev,
      inode: repositoryIdentity.ino,
    },
    lockDirectory: {
      path: resolve(repository.layout.repositoryLock),
      device: lockDirectoryIdentity.dev,
      inode: lockDirectoryIdentity.ino,
    },
    metadataPath,
    metadataIdentity,
    metadata,
    released: false,
  })
  return lock
}

interface QuarantinedLock {
  parent: string
  lock: string
  metadataPath: string
  entries: string[]
  metadata: RepositoryLockMetadata | null
}

async function quarantineLocksParent(repository: RepositoryHandle): Promise<QuarantinedLock> {
  const parent = `${repository.layout.locks}.quarantine-${randomUUID()}`
  try {
    await rename(repository.layout.locks, parent)
    await syncDirectory(repository.layout.root)
  } catch {
    throw new RepositoryError(
      'lock',
      'LOCK_CLEAR_RACE',
      'Repository lock cleanup lost the quarantine race; no lock was cleared',
    )
  }

  const lock = join(parent, 'repository.lock')
  let parentEntries: string[]
  let entries: string[]
  try {
    parentEntries = (await readdir(parent)).sort()
    if (parentEntries.length !== 1 || parentEntries[0] !== 'repository.lock') {
      throw new Error('unknown lock parent entries')
    }
    if (!(await lstat(lock)).isDirectory()) throw new Error('unsafe lock')
    entries = (await readdir(lock)).sort()
  } catch {
    await restoreQuarantine(repository, parent)
    throw new RepositoryError(
      'lock',
      'LOCK_HAS_UNKNOWN_ENTRIES',
      'Repository lock was not cleared because unknown lock entries exist',
    )
  }

  return {
    parent,
    lock,
    metadataPath: join(lock, 'owner.json'),
    entries,
    metadata: entries.includes('owner.json')
      ? await readLockMetadata(join(lock, 'owner.json'))
      : null,
  }
}

async function restoreQuarantine(repository: RepositoryHandle, quarantine: string): Promise<void> {
  try {
    await rename(quarantine, repository.layout.locks)
    await syncDirectory(repository.layout.root)
  } catch {
    throw new RepositoryError(
      'lock',
      'LOCK_QUARANTINE_RESTORE_FAILED',
      'Quarantined lock could not be restored; manual inspection is required',
    )
  }
}

async function publishEmptyLocksParent(repository: RepositoryHandle): Promise<void> {
  try {
    await mkdir(repository.layout.locks, { mode: 0o700 })
    await syncDirectory(repository.layout.root)
  } catch {
    throw new RepositoryError(
      'lock',
      'LOCK_PARENT_RECREATE_FAILED',
      'Lock directory could not be recreated; quarantined data was retained',
    )
  }
}

async function removeKnownQuarantine(quarantine: QuarantinedLock): Promise<void> {
  try {
    if (quarantine.entries.length === 1) await unlink(quarantine.metadataPath)
    await rmdir(quarantine.lock)
    await rmdir(quarantine.parent)
  } catch {
    throw new RepositoryError(
      'lock',
      'LOCK_QUARANTINE_CLEANUP_FAILED',
      'Old quarantined lock could not be removed; the active lock directory was preserved',
    )
  }
}

async function rejectAndRestore(
  repository: RepositoryHandle,
  quarantine: QuarantinedLock,
  code: string,
  message: string,
): Promise<never> {
  await restoreQuarantine(repository, quarantine.parent)
  throw new RepositoryError('lock', code, message)
}

export async function clearStaleRepositoryLock(
  repository: RepositoryHandle,
  expectedLockId: string,
  options: { now?: Date; staleAfterMs?: number } = {},
): Promise<void> {
  assertRepositoryWriteAuthorized(repository)
  const quarantine = await quarantineLocksParent(repository)
  if (
    quarantine.entries.length !== 1 ||
    quarantine.entries[0] !== 'owner.json' ||
    !quarantine.metadata ||
    quarantine.metadata.lockId !== expectedLockId ||
    !inspectMetadata(quarantine.metadata, options).staleCandidate
  ) {
    await rejectAndRestore(
      repository,
      quarantine,
      'LOCK_NOT_PROVEN_STALE',
      'Repository lock was not cleared because stale ownership could not be proven',
    )
  }

  await publishEmptyLocksParent(repository)
  await removeKnownQuarantine(quarantine)
}

function ownersMatch(
  actual: RepositoryLockMetadata['owner'],
  expected: RepositoryLockMetadata['owner'],
): boolean {
  return (
    actual.pid === expected.pid &&
    actual.hostname === expected.hostname &&
    actual.instanceId === expected.instanceId
  )
}

export async function clearConfirmedRepositoryLock(
  repository: RepositoryHandle,
  options: ConfirmedRepositoryLockClearOptions,
): Promise<void> {
  assertRepositoryWriteAuthorized(repository)
  if (options.confirm !== true) {
    throw new RepositoryError(
      'lock',
      'REMOTE_LOCK_CONFIRMATION_REQUIRED',
      'Explicit confirmation is required to clear a valid remote lock',
    )
  }
  if (
    typeof options.expectedLockId !== 'string' ||
    options.expectedLockId.length === 0 ||
    !options.expectedOwner ||
    !Number.isSafeInteger(options.expectedOwner.pid) ||
    options.expectedOwner.pid <= 0 ||
    typeof options.expectedOwner.hostname !== 'string' ||
    options.expectedOwner.hostname.length === 0 ||
    typeof options.expectedOwner.instanceId !== 'string' ||
    options.expectedOwner.instanceId.length === 0
  ) {
    throw new RepositoryError(
      'configuration',
      'INVALID_LOCK_CONFIRMATION',
      'Remote lock confirmation identity is invalid',
    )
  }

  const quarantine = await quarantineLocksParent(repository)
  if (quarantine.entries.length !== 1 || quarantine.entries[0] !== 'owner.json') {
    await rejectAndRestore(
      repository,
      quarantine,
      'LOCK_HAS_UNKNOWN_ENTRIES',
      'Repository lock was not cleared because unknown lock entries exist',
    )
  }
  const metadata = quarantine.metadata
  if (
    !metadata ||
    metadata.lockId !== options.expectedLockId ||
    !ownersMatch(metadata.owner, options.expectedOwner)
  ) {
    await rejectAndRestore(
      repository,
      quarantine,
      'LOCK_CONFIRMATION_MISMATCH',
      'Repository lock changed after it was displayed; no lock was cleared',
    )
  }
  if (!metadata || isOwnerAlive(metadata) !== null) {
    await rejectAndRestore(
      repository,
      quarantine,
      'LOCK_NOT_REMOTE',
      'Confirmed clearing is limited to locks owned by a different host',
    )
  }

  await publishEmptyLocksParent(repository)
  await removeKnownQuarantine(quarantine)
}

export async function clearOrphanedRepositoryLock(
  repository: RepositoryHandle,
  options: { confirm: boolean },
): Promise<void> {
  assertRepositoryWriteAuthorized(repository)
  if (options.confirm !== true) {
    throw new RepositoryError(
      'lock',
      'ORPHAN_LOCK_CONFIRMATION_REQUIRED',
      'Explicit confirmation is required to clear an orphaned lock',
    )
  }

  const quarantine = await quarantineLocksParent(repository)
  const onlyKnownEntries =
    quarantine.entries.length === 0 ||
    (quarantine.entries.length === 1 && quarantine.entries[0] === 'owner.json')
  if (!onlyKnownEntries) {
    await rejectAndRestore(
      repository,
      quarantine,
      'LOCK_HAS_UNKNOWN_ENTRIES',
      'Repository lock was not cleared because unknown lock entries exist',
    )
  }
  if (quarantine.metadata) {
    await rejectAndRestore(
      repository,
      quarantine,
      'LOCK_NOT_PROVEN_ORPHANED',
      'Repository lock was not cleared because it is owned or contains unknown entries',
    )
  }

  await publishEmptyLocksParent(repository)
  await removeKnownQuarantine(quarantine)
}

import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RecoveryPointManifestV1 } from '../engine/v1-backup.js'
import type { ContentProtector } from '../protection/index.js'
import { RepositoryError, acquireRepositoryLock, openRepository } from '../repository/index.js'
import type {
  ClassifiedIssue,
  OperationCategory,
  RepositoryHandle,
  RepositoryLock,
} from '../repository/index.js'
import { captureCurrentMetadata, restoreMetadata, verifyMetadata } from './metadata.js'
import {
  DirectoryEnsureError,
  assertDirectoryIdentity,
  assertSafeDirectory,
  atomicEnsureDirectory,
  atomicPublish,
  deleteEntrySafely,
  lstatIdentity,
  mkdirUnderRoot,
  pathUnder,
  pathsOverlap,
  readDirectoryBoundFile,
  readLinkSafely,
  readVerifiedFile,
} from './safe-io.js'
import type { PathIdentity } from './safe-io.js'
import {
  SafetyResidueError,
  acquireSafetyLease,
  assertSafetyLease,
  assertSafetyLeaseEntry,
  assertSafetyResumeExpectations,
  closeSafetyLease,
  createSafetyPoint,
  deactivateSafetyProtection,
  readSafetyBlob,
  readSafetyIntent,
  readSafetyPoint,
  safetyRoot,
} from './safety.js'
import type {
  SafetyCaptureItem,
  SafetyEntry,
  SafetyLease,
  SafetyManifest,
  SafetyPlanItem,
} from './safety.js'
import { RecoveryFailure, authenticateStaging } from './stage.js'
import type {
  ApplyItemResult,
  ApplyOptions,
  ApplyResult,
  ConflictPolicy,
  RecoveryCounts,
  RollbackOptions,
  StagedEntry,
  StagingDescriptor,
} from './types.js'
import { APPLY_FIDELITY_CONSENT } from './types.js'

const MAX_JOURNAL_BYTES = 16 * 1024 * 1024
const EMPTY_COUNTS: RecoveryCounts = {
  filesConsidered: 0,
  restored: 0,
  unchanged: 0,
  skipped: 0,
  conflicted: 0,
  failed: 0,
  fidelityLoss: 0,
  bytesRead: 0,
  bytesWritten: 0,
  bytesVerified: 0,
}

interface PlannedItem {
  entry: StagedEntry
  stagingPath: string
  targetPath: string
  targetLabel: string
  publicEntryId: string
  expected: PathIdentity | null
  status: 'pending' | 'unchanged' | 'skipped' | 'conflicted'
  hardlinkTargetPath?: string
  hardlinkDegraded: boolean
  externalParent: { path: string; identity: PathIdentity }
}

interface ApplyPlan {
  applyId: string
  safetyId: string
  fingerprint: string
  policy: ConflictPolicy
  items: PlannedItem[]
}

interface JournalItem {
  entryId: string
  status: 'pending' | 'published' | 'applied' | 'failed'
  finalDevice?: string
  finalInode?: string
  finalSize?: string
  finalModifiedAtNs?: string
  finalChangedAtNs?: string
  expectedDevice?: string
  expectedInode?: string
  expectedSize?: string
  expectedModifiedAtNs?: string
  expectedChangedAtNs?: string
  issueCode?: string
  fidelityLoss?: true
}

interface ApplyJournal {
  formatVersion: 1
  kind: 'restore-apply-journal' | 'restore-rollback-journal'
  applyId: string
  safetyId: string
  repositoryId: string
  pointId: string
  stagingId: string
  planFingerprint: string
  conflictPolicy: ConflictPolicy
  createdAt: string
  updatedAt: string
  items: JournalItem[]
}

class ApplyFailure extends Error {
  constructor(
    readonly category: Exclude<OperationCategory, 'success'>,
    readonly code: string,
    message: string,
    readonly nextAction?: string,
  ) {
    super(message)
  }
}

class ApplyInterruption extends Error {}

const issue = (
  code: string,
  category: ClassifiedIssue['category'],
  message: string,
  nextAction?: string,
): ClassifiedIssue => ({ code, category, message, ...(nextAction ? { nextAction } : {}) })

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeNow(now?: () => Date): Date {
  const value = now?.() ?? new Date()
  if (!Number.isFinite(value.getTime())) throw new Error('invalid clock')
  return value
}

function publicEntryId(entry: StagedEntry, secret: boolean): string {
  return secret ? `entry-${hash(entry.id).slice(0, 16)}` : entry.id
}

function targetLabel(sourceId: string, targetPath: string, secret: boolean): string {
  return secret ? `${sourceId}:<redacted>` : targetPath
}

function broadTarget(path: string): boolean {
  return new Set([
    '/',
    '/Applications',
    '/Library',
    '/System',
    '/Users',
    '/Volumes',
    '/private',
    '/usr',
  ]).has(resolve(path))
}

async function assertNoSymlinkParents(path: string): Promise<void> {
  const absolute = resolve(path)
  let current = resolve('/')
  const components = dirname(absolute).split(sep).filter(Boolean)
  for (const component of components) {
    current = join(current, component)
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!metadata)
      throw new ApplyFailure(
        'destination',
        'TARGET_PARENT_MISSING',
        'A target parent does not exist',
      )
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ApplyFailure('destination', 'UNSAFE_TARGET_PARENT', 'A target parent is unsafe')
    }
  }
}

async function desiredContentPresent(item: PlannedItem): Promise<boolean> {
  const current = item.expected
  if (!current || current.type !== item.entry.type) return false
  if (item.entry.type === 'file') {
    try {
      const content = await readVerifiedFile(
        item.targetPath,
        item.entry.metadata.size,
        item.entry.contentHash as string,
      )
      content.fill(0)
    } catch {
      return false
    }
  } else if (item.entry.type === 'symlink') {
    if ((await readLinkSafely(item.targetPath).catch(() => undefined)) !== item.entry.linkTarget)
      return false
  }
  if (item.entry.hardlinkTo && item.hardlinkTargetPath) {
    const anchor = await lstatIdentity(item.hardlinkTargetPath)
    if (!anchor || anchor.device !== current.device || anchor.inode !== current.inode) return false
  }
  return true
}

async function sameDesired(
  item: PlannedItem,
  metadataOptions: ApplyOptions['metadata'],
): Promise<boolean> {
  item.expected = await lstatIdentity(item.targetPath)
  if (!(await desiredContentPresent(item))) return false
  return (await verifyMetadata(item.targetPath, item.entry, metadataOptions)).length === 0
}

async function buildPlan(
  options: ApplyOptions,
  staging: StagingDescriptor,
  manifest: RecoveryPointManifestV1,
  stagingFidelityIssues: readonly ClassifiedIssue[],
  resumeSafety?: SafetyManifest,
): Promise<ApplyPlan> {
  const policy = options.conflictPolicy ?? 'error'
  if (!['error', 'overwrite', 'skip'].includes(policy)) {
    throw new ApplyFailure('configuration', 'INVALID_CONFLICT_POLICY', 'Conflict policy is invalid')
  }
  const selectedEntries = staging.entries.filter((entry) => entry.selectionRole === 'selected')
  const selectedSourceIds = [...new Set(selectedEntries.map((entry) => entry.sourceId))].sort()
  const mappings = [...options.targets]
    .map((mapping) => ({ sourceId: mapping.sourceId, targetPath: resolve(mapping.targetPath) }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
  if (
    mappings.length !== selectedSourceIds.length ||
    new Set(mappings.map((mapping) => mapping.sourceId)).size !== mappings.length ||
    selectedSourceIds.some((sourceId) => !mappings.some((mapping) => mapping.sourceId === sourceId))
  ) {
    throw new ApplyFailure(
      'configuration',
      'INCOMPLETE_TARGET_MAPPING',
      'Every selected source requires one explicit target mapping',
    )
  }
  for (const mapping of mappings) {
    if (
      !isAbsolute(
        options.targets.find((target) => target.sourceId === mapping.sourceId)?.targetPath ?? '',
      ) ||
      broadTarget(mapping.targetPath)
    ) {
      throw new ApplyFailure(
        'destination',
        'UNSAFE_TARGET',
        'A target mapping is broad or not absolute',
      )
    }
    if (
      pathsOverlap(mapping.targetPath, options.repositoryPath) ||
      pathsOverlap(mapping.targetPath, options.stagingPath)
    ) {
      throw new ApplyFailure(
        'destination',
        'TARGET_OVERLAP',
        'A target overlaps repository or staging state',
      )
    }
    await assertNoSymlinkParents(mapping.targetPath)
  }
  const externalParents = new Map<string, { path: string; identity: PathIdentity }>()
  for (const mapping of mappings) {
    const path = dirname(mapping.targetPath)
    externalParents.set(mapping.sourceId, { path, identity: await assertSafeDirectory(path) })
  }
  for (let index = 0; index < mappings.length; index++) {
    for (let other = index + 1; other < mappings.length; other++) {
      if (pathsOverlap(mappings[index].targetPath, mappings[other].targetPath)) {
        throw new ApplyFailure('destination', 'TARGET_MAPPING_OVERLAP', 'Target mappings overlap')
      }
    }
  }
  const sourceSensitivity = new Map(
    manifest.sources.map((source) => [source.id, source.sensitivity]),
  )
  const targetByEntry = new Map<string, string>()
  for (const entry of selectedEntries) {
    const root = mappings.find((mapping) => mapping.sourceId === entry.sourceId)?.targetPath
    if (!root) throw new Error('target mapping missing')
    const target = entry.relativePath === '.' ? root : resolve(root, entry.relativePath)
    if (entry.relativePath !== '.' && !pathUnder(root, target))
      throw new Error('target leaves mapping')
    targetByEntry.set(entry.id, target)
  }
  const items: PlannedItem[] = []
  const resumeItems = new Map((resumeSafety?.planItems ?? []).map((item) => [item.entryId, item]))
  if (resumeSafety && resumeItems.size !== selectedEntries.length)
    throw new ApplyFailure(
      'integrity',
      'SAFETY_PLAN_MISMATCH',
      'Authenticated Safety plan does not match selected recovery entries',
    )
  for (const entry of selectedEntries) {
    const targetPath = targetByEntry.get(entry.id) as string
    const resumeItem = resumeItems.get(entry.id)
    if (
      resumeSafety &&
      (!resumeItem ||
        resumeItem.sourceId !== entry.sourceId ||
        resumeItem.targetPath !== targetPath)
    )
      throw new ApplyFailure(
        'integrity',
        'SAFETY_PLAN_MISMATCH',
        'Authenticated Safety plan target binding changed',
      )
    const expected = resumeItem?.expected
      ? {
          device: BigInt(resumeItem.expected.device),
          inode: BigInt(resumeItem.expected.inode),
          type: resumeItem.expected.type,
          size: BigInt(resumeItem.expected.size),
          modifiedAtNs: BigInt(resumeItem.expected.modifiedAtNs),
          changedAtNs: BigInt(resumeItem.expected.changedAtNs),
        }
      : resumeItem
        ? null
        : await lstatIdentity(targetPath)
    const secret = sourceSensitivity.get(entry.sourceId) === 'secret'
    const capturedExternalParent = externalParents.get(entry.sourceId)
    const externalParent = resumeItem
      ? {
          path: resumeItem.externalParent.path,
          identity: {
            device: BigInt(resumeItem.externalParent.device),
            inode: BigInt(resumeItem.externalParent.inode),
            type: 'directory' as const,
            size: 0n,
            modifiedAtNs: 0n,
            changedAtNs: 0n,
          },
        }
      : capturedExternalParent
    if (!externalParent) throw new Error('mapping parent binding missing')
    const item: PlannedItem = {
      entry,
      stagingPath: resolve(options.stagingPath, entry.stagingRelativePath),
      targetPath,
      targetLabel: targetLabel(entry.sourceId, targetPath, secret),
      publicEntryId: publicEntryId(entry, secret),
      expected,
      status: 'pending',
      hardlinkDegraded: false,
      externalParent,
    }
    if (entry.hardlinkTo) {
      item.hardlinkTargetPath = targetByEntry.get(entry.hardlinkTo)
      item.hardlinkDegraded = !item.hardlinkTargetPath
    }
    if (resumeItem) item.status = resumeItem.status
    else if (await sameDesired(item, options.metadata)) item.status = 'unchanged'
    else if (expected && (expected.type === 'directory') !== (entry.type === 'directory')) {
      item.status = 'conflicted'
    } else if (expected && policy === 'error') item.status = 'conflicted'
    else if (expected && policy === 'skip') item.status = 'skipped'
    items.push(item)
  }
  const pendingTargets = items
    .filter((item) => item.status === 'pending')
    .map((item) => item.targetPath)
  for (const item of items) {
    if (
      item.entry.type === 'directory' &&
      item.status === 'unchanged' &&
      pendingTargets.some(
        (targetPath) => targetPath !== item.targetPath && pathUnder(item.targetPath, targetPath),
      )
    )
      item.status = 'pending'
  }
  const fingerprint = hash(
    JSON.stringify({
      repositoryId: staging.repositoryId,
      pointId: staging.pointId,
      stagingId: staging.stagingId,
      manifestFingerprint: staging.manifestFingerprint,
      stagingFidelityIssues,
      policy,
      targets: mappings,
      entries: items.map((item) => ({
        id: item.entry.id,
        target: item.targetPath,
        status: item.status,
        expected: item.expected
          ? {
              device: item.expected.device.toString(),
              inode: item.expected.inode.toString(),
              type: item.expected.type,
              size: item.expected.size.toString(),
              modifiedAtNs: item.expected.modifiedAtNs.toString(),
              changedAtNs: item.expected.changedAtNs.toString(),
            }
          : null,
        externalParent: {
          path: item.externalParent.path,
          device: item.externalParent.identity.device.toString(),
          inode: item.externalParent.identity.inode.toString(),
        },
      })),
    }),
  )
  if (resumeSafety && resumeSafety.planFingerprint !== fingerprint)
    throw new ApplyFailure(
      'integrity',
      'SAFETY_PLAN_MISMATCH',
      'Authenticated Safety plan fingerprint does not match reconstructed inputs',
    )
  const applyId = resumeSafety?.applyId ?? `apply-${fingerprint.slice(0, 32)}`
  if (options.applyId && options.applyId !== applyId) {
    throw new ApplyFailure(
      'configuration',
      'APPLY_RESUME_MISMATCH',
      'Apply ID does not match this bound plan',
    )
  }
  return {
    applyId,
    safetyId: resumeSafety?.safetyId ?? `safety-${fingerprint.slice(0, 32)}`,
    fingerprint,
    policy,
    items,
  }
}

function journalPath(stagingPath: string, applyId: string, kind: ApplyJournal['kind']): string {
  return join(
    stagingPath,
    '.restore-control',
    'journals',
    `${kind === 'restore-apply-journal' ? applyId : `rollback-${applyId}`}.protected`,
  )
}

async function writeJournal(
  stagingPath: string,
  journal: ApplyJournal,
  protector: ContentProtector,
): Promise<void> {
  await mkdirUnderRoot(stagingPath, '.restore-control')
  await mkdirUnderRoot(stagingPath, '.restore-control/journals')
  const path = journalPath(stagingPath, journal.applyId, journal.kind)
  const protectedContent = await protector.seal(Buffer.from(JSON.stringify(journal)), {
    repositoryId: journal.repositoryId,
    purpose: 'manifest',
    objectId: `${journal.kind}:${journal.applyId}`,
  })
  try {
    await atomicPublish({
      kind: 'file',
      destination: path,
      expected: await lstatIdentity(path),
      payload: protectedContent,
    })
  } finally {
    protectedContent.fill(0)
  }
}

async function readJournal(
  stagingPath: string,
  applyId: string,
  kind: ApplyJournal['kind'],
  repositoryId: string,
  protector: ContentProtector,
  rollbackAbsentEntryIds?: ReadonlySet<string>,
): Promise<ApplyJournal | null> {
  const path = journalPath(stagingPath, applyId, kind)
  if (!(await lstatIdentity(path))) return null
  const protectedContent = await readDirectoryBoundFile(
    dirname(path),
    basename(path),
    MAX_JOURNAL_BYTES,
  )
  let plaintext: Buffer | undefined
  try {
    plaintext = await protector.open(protectedContent, {
      repositoryId,
      purpose: 'manifest',
      objectId: `${kind}:${applyId}`,
    })
    const journal = JSON.parse(plaintext.toString('utf8')) as ApplyJournal
    const exact = (actual: object, expected: string[]) =>
      Object.keys(actual).sort().join(',') === [...expected].sort().join(',')
    if (
      !exact(journal, [
        'formatVersion',
        'kind',
        'applyId',
        'safetyId',
        'repositoryId',
        'pointId',
        'stagingId',
        'planFingerprint',
        'conflictPolicy',
        'createdAt',
        'updatedAt',
        'items',
      ]) ||
      journal.formatVersion !== 1 ||
      journal.kind !== kind ||
      journal.applyId !== applyId ||
      journal.repositoryId !== repositoryId ||
      !/^[0-9a-f]{64}$/.test(journal.planFingerprint) ||
      !Number.isFinite(Date.parse(journal.createdAt)) ||
      !Number.isFinite(Date.parse(journal.updatedAt)) ||
      !['error', 'overwrite', 'skip'].includes(journal.conflictPolicy) ||
      !Array.isArray(journal.items) ||
      journal.items.length > 100_000 ||
      new Set(journal.items.map((item) => item.entryId)).size !== journal.items.length ||
      journal.items.some((item) => {
        if (item.status !== 'published' && item.status !== 'applied') return false
        const tombstone = [
          item.finalDevice,
          item.finalInode,
          item.finalSize,
          item.finalModifiedAtNs,
          item.finalChangedAtNs,
        ].every((value) => value === '0')
        const authorizedTombstone =
          kind === 'restore-rollback-journal' && rollbackAbsentEntryIds?.has(item.entryId) === true
        return tombstone !== authorizedTombstone
      }) ||
      journal.items.some(
        (item) =>
          !item ||
          typeof item.entryId !== 'string' ||
          !['pending', 'published', 'applied', 'failed'].includes(item.status) ||
          !exact(item, [
            'entryId',
            'status',
            ...(item.finalDevice === undefined ? [] : ['finalDevice']),
            ...(item.finalInode === undefined ? [] : ['finalInode']),
            ...(item.finalSize === undefined ? [] : ['finalSize']),
            ...(item.finalModifiedAtNs === undefined ? [] : ['finalModifiedAtNs']),
            ...(item.finalChangedAtNs === undefined ? [] : ['finalChangedAtNs']),
            ...(item.expectedDevice === undefined ? [] : ['expectedDevice']),
            ...(item.expectedInode === undefined ? [] : ['expectedInode']),
            ...(item.expectedSize === undefined ? [] : ['expectedSize']),
            ...(item.expectedModifiedAtNs === undefined ? [] : ['expectedModifiedAtNs']),
            ...(item.expectedChangedAtNs === undefined ? [] : ['expectedChangedAtNs']),
            ...(item.issueCode === undefined ? [] : ['issueCode']),
            ...(item.fidelityLoss === undefined ? [] : ['fidelityLoss']),
          ]) ||
          (item.issueCode !== undefined && typeof item.issueCode !== 'string') ||
          (item.fidelityLoss !== undefined && item.fidelityLoss !== true) ||
          ([
            item.expectedDevice,
            item.expectedInode,
            item.expectedSize,
            item.expectedModifiedAtNs,
            item.expectedChangedAtNs,
          ].some((value) => value !== undefined) &&
            ![
              item.expectedDevice,
              item.expectedInode,
              item.expectedSize,
              item.expectedModifiedAtNs,
              item.expectedChangedAtNs,
            ].every((value) => typeof value === 'string' && /^\d+$/.test(value))) ||
          (item.status === 'published' || item.status === 'applied'
            ? ![
                item.finalDevice,
                item.finalInode,
                item.finalSize,
                item.finalModifiedAtNs,
                item.finalChangedAtNs,
              ].every((value) => typeof value === 'string' && /^\d+$/.test(value))
            : [
                item.finalDevice,
                item.finalInode,
                item.finalSize,
                item.finalModifiedAtNs,
                item.finalChangedAtNs,
              ].some((value) => value !== undefined)),
      )
    )
      throw new Error(`invalid ${kind} journal`)
    return journal
  } finally {
    protectedContent.fill(0)
    plaintext?.fill(0)
  }
}

async function openForMutation(options: ApplyOptions | RollbackOptions): Promise<{
  repository: RepositoryHandle
  lock: RepositoryLock
}> {
  const repository = await openRepository(options.repositoryPath, {
    intent: 'write',
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
  })
  try {
    const lock = await acquireRepositoryLock(repository, 'recovery-apply')
    return { repository, lock }
  } catch (error) {
    repository.close()
    throw error
  }
}

async function publishItem(
  item: PlannedItem,
  options: ApplyOptions,
  validateAncestors: () => Promise<PathIdentity | undefined>,
  validateSafety: () => Promise<void>,
): Promise<PathIdentity> {
  await validateSafety()
  const expectedParent = await validateAncestors()
  const publishBound = async (operation: () => Promise<PathIdentity>): Promise<PathIdentity> => {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ApplyFailure) throw error
      if (error instanceof DirectoryEnsureError) {
        if (error.outcome === 'drift')
          throw new ApplyFailure(
            'destination',
            'APPLY_TARGET_DRIFT',
            'A directory target changed before publication',
          )
        throw new ApplyFailure(
          'integrity',
          'APPLY_PUBLICATION_AMBIGUOUS',
          'Directory publication may have completed without a durable acknowledgement',
          'Inspect the bound destination directory and retry with the same apply ID',
        )
      }
      const [current, currentParent, currentExternalParent] = await Promise.all([
        lstatIdentity(item.targetPath),
        lstatIdentity(dirname(item.targetPath)),
        lstatIdentity(item.externalParent.path),
      ])
      const identityMatches = (actual: PathIdentity | null, expected: PathIdentity | null) =>
        actual === null
          ? expected === null
          : Boolean(
              expected &&
                actual.device === expected.device &&
                actual.inode === expected.inode &&
                actual.type === expected.type &&
                actual.size === expected.size &&
                actual.modifiedAtNs === expected.modifiedAtNs &&
                actual.changedAtNs === expected.changedAtNs,
            )
      const parentChanged =
        !expectedParent ||
        currentParent?.type !== 'directory' ||
        currentParent.device !== expectedParent.device ||
        currentParent.inode !== expectedParent.inode ||
        currentExternalParent?.type !== 'directory' ||
        currentExternalParent.device !== item.externalParent.identity.device ||
        currentExternalParent.inode !== item.externalParent.identity.inode
      if (parentChanged || !identityMatches(current, item.expected)) {
        if (
          item.entry.type === 'directory' &&
          item.expected === null &&
          !parentChanged &&
          current?.type === 'directory'
        )
          throw new ApplyFailure(
            'integrity',
            'APPLY_PUBLICATION_AMBIGUOUS',
            'Directory publication may have completed without a durable acknowledgement',
            'Inspect the bound destination directory and retry with the same apply ID',
          )
        throw new ApplyFailure(
          'destination',
          'APPLY_TARGET_DRIFT',
          'A target or its bound parent changed during publication',
        )
      }
      throw error
    }
  }
  let published: PathIdentity
  if (item.entry.type === 'directory') {
    published = await publishBound(() =>
      atomicEnsureDirectory(
        item.targetPath,
        item.expected,
        expectedParent,
        options.directoryAcknowledgementMode,
      ),
    )
  } else if (item.entry.type === 'symlink') {
    published = await publishBound(() =>
      atomicPublish({
        kind: 'symlink',
        destination: item.targetPath,
        expected: item.expected,
        ...(expectedParent ? { expectedParent } : {}),
        payload: item.entry.linkTarget as string,
      }),
    )
  } else if (item.entry.hardlinkTo && item.hardlinkTargetPath) {
    const hardlinkTargetPath = item.hardlinkTargetPath
    const source = await lstatIdentity(hardlinkTargetPath)
    if (source?.type !== 'file') throw new Error('applied hardlink anchor missing')
    published = await publishBound(() =>
      atomicPublish({
        kind: 'hardlink',
        destination: item.targetPath,
        expected: item.expected,
        ...(expectedParent ? { expectedParent } : {}),
        hardlinkSource: { path: hardlinkTargetPath, identity: source },
      }),
    )
  } else {
    const content = await readVerifiedFile(
      item.stagingPath,
      item.entry.metadata.size,
      item.entry.contentHash as string,
    )
    try {
      published = await publishBound(() =>
        atomicPublish({
          kind: 'file',
          destination: item.targetPath,
          expected: item.expected,
          ...(expectedParent ? { expectedParent } : {}),
          payload: content,
        }),
      )
    } finally {
      content.fill(0)
    }
  }
  return published
}

async function safetyExpectationMatches(
  entry: SafetyEntry,
  progress?: JournalItem,
): Promise<boolean> {
  const current = await lstatIdentity(entry.targetPath)
  if (entry.before.state === 'absent') return current === null
  if (progress?.expectedDevice !== undefined) {
    return Boolean(
      current &&
        current.type === entry.before.type &&
        current.device.toString() === progress.expectedDevice &&
        current.inode.toString() === progress.expectedInode &&
        current.size.toString() === progress.expectedSize &&
        current.modifiedAtNs.toString() === progress.expectedModifiedAtNs &&
        current.changedAtNs.toString() === progress.expectedChangedAtNs,
    )
  }
  return Boolean(
    current &&
      current.type === entry.before.type &&
      current.device.toString() === entry.before.device &&
      current.inode.toString() === entry.before.inode &&
      current.size === BigInt(entry.before.metadata.size) &&
      current.modifiedAtNs === BigInt(entry.before.metadata.modifiedAtNs) &&
      current.changedAtNs.toString() === entry.before.changedAtNs,
  )
}

async function recordHardlinkSiblingExpectations(
  publishedEntryId: string,
  manifest: SafetyManifest,
  journal: ApplyJournal,
  metadata: ApplyOptions['metadata'],
): Promise<void> {
  const published = manifest.entries.find((entry) => entry.entryId === publishedEntryId)
  if (published?.before.state !== 'present' || published.before.type !== 'file') return
  for (const entry of manifest.entries) {
    if (
      entry.entryId === publishedEntryId ||
      entry.before.state !== 'present' ||
      entry.before.type !== 'file' ||
      entry.before.device !== published.before.device ||
      entry.before.inode !== published.before.inode
    )
      continue
    const current = await lstatIdentity(entry.targetPath)
    if (
      current?.type === 'file' &&
      current.device.toString() === entry.before.device &&
      current.inode.toString() === entry.before.inode &&
      current.size === BigInt(entry.before.metadata.size) &&
      current.modifiedAtNs === BigInt(entry.before.metadata.modifiedAtNs)
    ) {
      const capturedMetadata = await captureCurrentMetadata(entry.targetPath, 'file', metadata)
      if (JSON.stringify(capturedMetadata) !== JSON.stringify(entry.before.metadata)) continue
      const content = await readVerifiedFile(
        entry.targetPath,
        entry.before.plaintextBytes as number,
        entry.before.contentHash as string,
      )
      content.fill(0)
      const progress = journal.items.find((candidate) => candidate.entryId === entry.entryId)
      if (!progress) throw new Error('hardlink sibling journal entry missing')
      progress.expectedDevice = current.device.toString()
      progress.expectedInode = current.inode.toString()
      progress.expectedSize = current.size.toString()
      progress.expectedModifiedAtNs = current.modifiedAtNs.toString()
      progress.expectedChangedAtNs = current.changedAtNs.toString()
    }
  }
}

function matchesProgressIdentity(current: PathIdentity | null, progress: JournalItem): boolean {
  return Boolean(
    current &&
      current.device.toString() === progress.finalDevice &&
      current.inode.toString() === progress.finalInode &&
      current.size.toString() === progress.finalSize &&
      current.modifiedAtNs.toString() === progress.finalModifiedAtNs &&
      current.changedAtNs.toString() === progress.finalChangedAtNs,
  )
}

function recordProgressIdentity(progress: JournalItem, current: PathIdentity | null): void {
  progress.finalDevice = current?.device.toString() ?? '0'
  progress.finalInode = current?.inode.toString() ?? '0'
  progress.finalSize = current?.size.toString() ?? '0'
  progress.finalModifiedAtNs = current?.modifiedAtNs.toString() ?? '0'
  progress.finalChangedAtNs = current?.changedAtNs.toString() ?? '0'
}

function samePathIdentity(actual: PathIdentity | null, expected: PathIdentity | null): boolean {
  return actual === null
    ? expected === null
    : Boolean(
        expected &&
          actual.device === expected.device &&
          actual.inode === expected.inode &&
          actual.type === expected.type &&
          actual.size === expected.size &&
          actual.modifiedAtNs === expected.modifiedAtNs &&
          actual.changedAtNs === expected.changedAtNs,
      )
}

async function verifyAppliedContent(item: PlannedItem): Promise<void> {
  const current = await lstatIdentity(item.targetPath)
  if (!current || current.type !== item.entry.type) throw new Error('applied type mismatch')
  if (item.entry.type === 'file') {
    const content = await readVerifiedFile(
      item.targetPath,
      item.entry.metadata.size,
      item.entry.contentHash as string,
    )
    content.fill(0)
    if (item.entry.hardlinkTo && item.hardlinkTargetPath) {
      const anchor = await lstatIdentity(item.hardlinkTargetPath)
      if (!anchor || anchor.inode !== current.inode || anchor.device !== current.device)
        throw new Error('hardlink fidelity mismatch')
    }
  } else if (
    item.entry.type === 'symlink' &&
    (await readLinkSafely(item.targetPath)) !== item.entry.linkTarget
  ) {
    throw new Error('applied link mismatch')
  }
}

async function verifyAppliedItem(
  item: PlannedItem,
  metadata: ApplyOptions['metadata'],
): Promise<void> {
  await verifyAppliedContent(item)
  if ((await verifyMetadata(item.targetPath, item.entry, metadata)).length > 0) {
    throw new ApplyFailure(
      'partial',
      'METADATA_FIDELITY_LOSS',
      'Applied metadata has fidelity loss',
    )
  }
}

async function assertInitialReviewedPlan(
  plan: ApplyPlan,
  metadata: ApplyOptions['metadata'],
): Promise<void> {
  for (const item of plan.items) {
    try {
      await assertDirectoryIdentity(item.externalParent.path, item.externalParent.identity)
    } catch {
      throw new ApplyFailure(
        'destination',
        'APPLY_TARGET_DRIFT',
        'A reviewed mapping parent changed before execution',
      )
    }
    if (item.status !== 'unchanged') continue
    if (!samePathIdentity(await lstatIdentity(item.targetPath), item.expected))
      throw new ApplyFailure(
        'destination',
        'APPLY_TARGET_DRIFT',
        'A reviewed unchanged target changed before execution',
      )
    try {
      await verifyAppliedItem(item, metadata)
    } catch {
      throw new ApplyFailure(
        'destination',
        'APPLY_TARGET_DRIFT',
        'A reviewed unchanged target no longer matches recovery data',
      )
    }
  }
}

function assertSafetyMatchesReviewedPlan(plan: ApplyPlan, safety: SafetyManifest): void {
  for (const item of plan.items) {
    const captured = safety.entries.find((entry) => entry.entryId === item.entry.id)
    if (item.status !== 'pending') {
      if (captured)
        throw new ApplyFailure(
          'integrity',
          'SAFETY_PLAN_MISMATCH',
          'Safety captured an entry outside the reviewed destructive set',
        )
      continue
    }
    const expected = item.expected
    const matches =
      captured &&
      captured.targetPath === item.targetPath &&
      captured.externalParent.path === item.externalParent.path &&
      captured.externalParent.device === item.externalParent.identity.device.toString() &&
      captured.externalParent.inode === item.externalParent.identity.inode.toString() &&
      (expected === null
        ? captured.before.state === 'absent'
        : captured.before.state === 'present' &&
          captured.before.type === expected.type &&
          captured.before.device === expected.device.toString() &&
          captured.before.inode === expected.inode.toString() &&
          captured.before.metadata.size === Number(expected.size) &&
          captured.before.metadata.modifiedAtNs === expected.modifiedAtNs.toString() &&
          captured.before.changedAtNs === expected.changedAtNs.toString())
    if (!matches)
      throw new ApplyFailure(
        'destination',
        'APPLY_TARGET_DRIFT',
        'Safety capture no longer matches the reviewed target identity',
      )
  }
}

function resultItems(plan: ApplyPlan, journal?: ApplyJournal): ApplyItemResult[] {
  return plan.items.map((item) => {
    const progress = journal?.items.find((candidate) => candidate.entryId === item.entry.id)
    const status =
      item.status === 'unchanged'
        ? 'unchanged'
        : item.status === 'skipped'
          ? 'skipped'
          : item.status === 'conflicted'
            ? 'conflicted'
            : progress?.status === 'applied' || progress?.fidelityLoss === true
              ? 'applied'
              : progress?.status === 'published'
                ? 'pending'
                : progress?.status === 'failed'
                  ? 'failed'
                  : 'pending'
    return {
      entryId: item.publicEntryId,
      sourceId: item.entry.sourceId,
      targetLabel: item.targetLabel,
      status,
      ...(progress?.issueCode ? { issueCode: progress.issueCode } : {}),
    }
  })
}

function countsFor(plan: ApplyPlan, journal?: ApplyJournal): RecoveryCounts {
  const counts = { ...EMPTY_COUNTS }
  counts.filesConsidered = plan.items.filter((item) => item.entry.type === 'file').length
  for (const item of resultItems(plan, journal)) {
    if (item.status === 'applied') counts.restored++
    else if (item.status === 'unchanged') counts.unchanged++
    else if (item.status === 'skipped') counts.skipped++
    else if (item.status === 'conflicted') counts.conflicted++
    else if (item.status === 'failed') counts.failed++
  }
  counts.fidelityLoss = (journal?.items ?? []).filter((item) => item.fidelityLoss).length
  counts.bytesWritten = plan.items
    .filter(
      (item) =>
        journal?.items.find((progress) => progress.entryId === item.entry.id)?.status ===
          'applied' && item.entry.type === 'file',
    )
    .reduce((sum, item) => sum + item.entry.metadata.size, 0)
  return counts
}

function failureIssue(error: unknown): ClassifiedIssue {
  if (error instanceof ApplyFailure)
    return issue(error.code, error.category, error.message, error.nextAction)
  if (error instanceof RecoveryFailure) return issue(error.code, error.category, error.message)
  if (error instanceof SafetyResidueError)
    return issue(error.code, 'integrity', error.message, error.nextAction)
  if (error instanceof RepositoryError) return issue(error.code, error.category, error.message)
  return issue('APPLY_FAILED', 'integrity', 'Recovery apply could not be completed safely')
}

const fidelityConsentInstruction = `Re-run with --accept-staging-fidelity-issues ${APPLY_FIDELITY_CONSENT}`

function stagingFidelityIssues(entries: readonly ClassifiedIssue[]): ClassifiedIssue[] {
  const canonical = entries
    .filter((entry) => entry.category === 'partial')
    .map((entry) => ({
      code: entry.code,
      category: entry.category,
      message: entry.message,
      ...(entry.nextAction ? { nextAction: entry.nextAction } : {}),
    }))
    .sort((left, right) => {
      const leftValue = JSON.stringify(left)
      const rightValue = JSON.stringify(right)
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
    })
  return canonical.filter(
    (entry, index) => index === 0 || JSON.stringify(entry) !== JSON.stringify(canonical[index - 1]),
  )
}

function appendUniqueIssues(
  target: ClassifiedIssue[],
  additions: readonly ClassifiedIssue[],
): void {
  const existing = new Set(
    target.map((entry) => `${entry.category}\0${entry.code}\0${entry.message}`),
  )
  for (const entry of additions) {
    const key = `${entry.category}\0${entry.code}\0${entry.message}`
    if (existing.has(key)) continue
    existing.add(key)
    target.push(entry)
  }
}

function requireStagingFidelityConsent(
  options: ApplyOptions,
  fidelityIssues: readonly ClassifiedIssue[],
): void {
  if (fidelityIssues.length === 0 || options.fidelityConsent === APPLY_FIDELITY_CONSENT) return
  throw new ApplyFailure(
    'cancelled',
    'APPLY_FIDELITY_CONSENT_REQUIRED',
    'Authenticated staging reports fidelity issues and requires exact explicit consent',
    fidelityConsentInstruction,
  )
}

export async function applyStaging(options: ApplyOptions): Promise<ApplyResult> {
  const started = safeNow(options.now)
  let plan: ApplyPlan | undefined
  let staging: StagingDescriptor | undefined
  let journal: ApplyJournal | undefined
  let safetyId: string | null = null
  let repository: RepositoryHandle | undefined
  let lock: RepositoryLock | undefined
  let safetyLease: SafetyLease | undefined
  const issues: ClassifiedIssue[] = []
  try {
    const authenticated = await authenticateStaging(options, options.stagingPath, options.metadata)
    staging = authenticated.descriptor
    const authenticatedFidelityIssues = stagingFidelityIssues(authenticated.issues)
    appendUniqueIssues(issues, authenticatedFidelityIssues)
    let resumeSafety: SafetyManifest | undefined
    if (options.applyId && /^apply-[0-9a-f]{32}$/.test(options.applyId)) {
      const derivedSafetyId = `safety-${options.applyId.slice('apply-'.length)}`
      const manifestPath = join(
        safetyRoot(options.stagingPath, derivedSafetyId),
        'manifest.protected',
      )
      const intentPath = join(safetyRoot(options.stagingPath, derivedSafetyId), 'intent.protected')
      const hasManifest = Boolean(await lstatIdentity(manifestPath))
      if (hasManifest || (await lstatIdentity(intentPath))) {
        const resumeRepository = await openRepository(options.repositoryPath, {
          intent: 'read',
          expectedRepositoryId: options.expectedRepositoryId,
          expectedProtection: options.expectedProtection,
          ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
        })
        try {
          if (!resumeRepository.protector)
            throw new ApplyFailure(
              'authentication',
              'APPLY_AUTHENTICATION_REQUIRED',
              'Repository protector is unavailable',
            )
          if (hasManifest) {
            resumeSafety = await readSafetyPoint(
              options.stagingPath,
              derivedSafetyId,
              staging.repositoryId,
              resumeRepository.protector,
              { allowMissingProtection: true },
            )
          } else {
            resumeSafety = await readSafetyIntent(
              options.stagingPath,
              derivedSafetyId,
              staging.repositoryId,
              resumeRepository.protector,
            )
          }
          if (
            resumeSafety.applyId !== options.applyId ||
            resumeSafety.stagingId !== staging.stagingId ||
            resumeSafety.pointId !== staging.pointId ||
            resumeSafety.repositoryId !== staging.repositoryId ||
            resumeSafety.protection !== staging.protection ||
            resumeSafety.stagingPathFingerprint !== hash(resolve(options.stagingPath))
          )
            throw new ApplyFailure(
              'integrity',
              'SAFETY_PLAN_MISMATCH',
              'Authenticated Safety resume binding does not match staging',
            )
        } finally {
          resumeRepository.close()
        }
      }
    }
    plan = await buildPlan(
      options,
      staging,
      authenticated.manifest,
      authenticatedFidelityIssues,
      resumeSafety,
    )
    safetyId = plan.safetyId
    if (plan.items.some((item) => item.status === 'conflicted')) {
      throw new ApplyFailure(
        'destination',
        'APPLY_CONFLICT',
        'Apply has unresolved target conflicts',
      )
    }
    if (options.dryRun !== false) {
      if (plan.items.some((item) => item.status === 'skipped'))
        issues.push(
          issue('APPLY_ITEMS_SKIPPED', 'warning', 'Some conflicting entries would be skipped'),
        )
      return {
        operation: 'apply',
        state:
          authenticatedFidelityIssues.length > 0
            ? 'partial'
            : issues.length
              ? 'warning'
              : 'success',
        category:
          authenticatedFidelityIssues.length > 0
            ? 'partial'
            : issues.length
              ? 'warning'
              : 'success',
        dryRun: true,
        startedAt: started.toISOString(),
        endedAt: safeNow(options.now).toISOString(),
        repositoryId: staging.repositoryId,
        protection: staging.protection,
        pointId: staging.pointId,
        stagingId: staging.stagingId,
        applyId: plan.applyId,
        safetyId: null,
        conflictPolicy: plan.policy,
        planFingerprint: plan.fingerprint,
        counts: countsFor(plan),
        items: resultItems(plan),
        issues,
        nextAction:
          authenticatedFidelityIssues.length > 0
            ? fidelityConsentInstruction
            : 'Run apply with dryRun=false after reviewing this bound plan',
      }
    }
    requireStagingFidelityConsent(options, authenticatedFidelityIssues)
    const opened = await openForMutation(options)
    repository = opened.repository
    lock = opened.lock
    if (!repository.protector)
      throw new ApplyFailure(
        'authentication',
        'APPLY_AUTHENTICATION_REQUIRED',
        'Repository protector is unavailable',
      )
    const rebound = await authenticateStaging(options, options.stagingPath, options.metadata)
    if (JSON.stringify(rebound.descriptor) !== JSON.stringify(staging))
      throw new Error('staging changed after lock')
    const reboundFidelityIssues = stagingFidelityIssues(rebound.issues)
    appendUniqueIssues(issues, reboundFidelityIssues)
    requireStagingFidelityConsent(options, reboundFidelityIssues)
    if (JSON.stringify(reboundFidelityIssues) !== JSON.stringify(authenticatedFidelityIssues))
      throw new ApplyFailure(
        'integrity',
        'APPLY_FIDELITY_CHANGED',
        'Authenticated staging fidelity issues changed after the mutation lock was acquired',
        'Run a new dry-run and review the changed staging fidelity issues',
      )
    const safetyItems: SafetyCaptureItem[] = plan.items
      .filter((item) => item.status === 'pending')
      .map((item) => ({
        entry: item.entry,
        targetPath: item.targetPath,
        targetLabel: item.targetLabel,
        externalParent: {
          path: item.externalParent.path,
          device: item.externalParent.identity.device.toString(),
          inode: item.externalParent.identity.inode.toString(),
        },
      }))
    const safetyPlanItems: SafetyPlanItem[] = plan.items.map((item) => {
      if (item.status === 'conflicted') throw new Error('conflicted plan cannot create Safety')
      return {
        entryId: item.entry.id,
        sourceId: item.entry.sourceId,
        targetPath: item.targetPath,
        status: item.status,
        externalParent: {
          path: item.externalParent.path,
          device: item.externalParent.identity.device.toString(),
          inode: item.externalParent.identity.inode.toString(),
        },
        expected: item.expected
          ? {
              device: item.expected.device.toString(),
              inode: item.expected.inode.toString(),
              type: item.expected.type,
              size: item.expected.size.toString(),
              modifiedAtNs: item.expected.modifiedAtNs.toString(),
              changedAtNs: item.expected.changedAtNs.toString(),
            }
          : null,
      }
    })
    let safety = await createSafetyPoint({
      stagingPath: options.stagingPath,
      staging,
      safetyId: plan.safetyId,
      applyId: plan.applyId,
      planFingerprint: plan.fingerprint,
      planItems: safetyPlanItems,
      items: safetyItems,
      protector: repository.protector,
      now: started,
      metadata: options.metadata,
      beforePublish: options.beforeSafetyPublish,
      afterManifestPublish: options.afterSafetyManifestPublish,
      allowIntentResume: options.applyId !== undefined,
    })
    await options.afterSafetyPublish?.()
    safety = await readSafetyPoint(
      options.stagingPath,
      plan.safetyId,
      staging.repositoryId,
      repository.protector,
    )
    assertSafetyMatchesReviewedPlan(plan, safety)
    const existingJournal = await readJournal(
      options.stagingPath,
      plan.applyId,
      'restore-apply-journal',
      staging.repositoryId,
      repository.protector,
    )
    if (!existingJournal) {
      assertSafetyMatchesReviewedPlan(plan, safety)
      try {
        await assertSafetyResumeExpectations(safety, options.metadata)
      } catch {
        throw new ApplyFailure(
          'destination',
          'APPLY_TARGET_DRIFT',
          'A reviewed target changed during Safety capture',
        )
      }
      await assertInitialReviewedPlan(plan, options.metadata)
    }
    if (!existingJournal && options.beforeTargetPublish) {
      for (const item of plan.items.filter((candidate) => candidate.status === 'pending'))
        await options.beforeTargetPublish(item.targetPath, item.entry)
      safety = await readSafetyPoint(
        options.stagingPath,
        plan.safetyId,
        staging.repositoryId,
        repository.protector,
      )
      assertSafetyMatchesReviewedPlan(plan, safety)
      try {
        await assertSafetyResumeExpectations(safety, options.metadata)
      } catch {
        throw new ApplyFailure(
          'destination',
          'APPLY_TARGET_DRIFT',
          'A reviewed target changed during apply preflight',
        )
      }
      await assertInitialReviewedPlan(plan, options.metadata)
    }
    safetyLease = await acquireSafetyLease(options.stagingPath, safety, repository.protector)
    const ensureSafetyLease = async (): Promise<void> => {
      await assertSafetyLease(
        safetyLease as SafetyLease,
        safety,
        repository?.protector as ContentProtector,
      )
    }
    const ensureSafetyEntry = async (item: PlannedItem): Promise<void> => {
      await assertSafetyLeaseEntry(safetyLease as SafetyLease, item.entry.id)
    }
    const runAfterTargetPublish = async (item: PlannedItem): Promise<void> => {
      let interrupted = false
      try {
        await options.afterTargetPublish?.(item.targetPath, item.entry)
      } catch {
        interrupted = true
      }
      await ensureSafetyEntry(item)
      if (interrupted) throw new ApplyInterruption('apply interrupted after durable publication')
    }
    journal = existingJournal ?? {
      formatVersion: 1,
      kind: 'restore-apply-journal',
      applyId: plan.applyId,
      safetyId: plan.safetyId,
      repositoryId: staging.repositoryId,
      pointId: staging.pointId,
      stagingId: staging.stagingId,
      planFingerprint: plan.fingerprint,
      conflictPolicy: plan.policy,
      createdAt: started.toISOString(),
      updatedAt: started.toISOString(),
      items: plan.items
        .filter((item) => item.status === 'pending')
        .map((item) => ({ entryId: item.entry.id, status: 'pending' })),
    }
    if (
      journal.planFingerprint !== plan.fingerprint ||
      journal.conflictPolicy !== plan.policy ||
      journal.safetyId !== plan.safetyId
    )
      throw new ApplyFailure(
        'configuration',
        'APPLY_JOURNAL_MISMATCH',
        'Apply journal does not match this plan',
      )
    const safetyIds = safety.entries.map((entry) => entry.entryId).sort()
    const pendingIds = journal.items.map((item) => item.entryId).sort()
    const activePlan = plan
    if (
      pendingIds.join('\0') !== safetyIds.join('\0') ||
      pendingIds.some((entryId) => !activePlan.items.some((item) => item.entry.id === entryId))
    ) {
      throw new ApplyFailure(
        'integrity',
        'APPLY_JOURNAL_MISMATCH',
        'Apply journal entry set was modified',
      )
    }
    for (const item of activePlan.items) {
      if (pendingIds.includes(item.entry.id)) item.status = 'pending'
    }
    await writeJournal(options.stagingPath, journal, repository.protector)
    const ordered = plan.items
      .filter((item) => item.status === 'pending')
      .sort((left, right) => {
        const rank = (entry: StagedEntry) =>
          entry.type === 'directory'
            ? 0
            : entry.type === 'file' && !entry.hardlinkTo
              ? 1
              : entry.hardlinkTo
                ? 2
                : 3
        return (
          rank(left.entry) - rank(right.entry) ||
          left.entry.relativePath.split('/').length - right.entry.relativePath.split('/').length
        )
      })
    const activeJournal = journal
    const persist = async () => {
      activeJournal.updatedAt = safeNow(options.now).toISOString()
      await writeJournal(
        options.stagingPath,
        activeJournal,
        repository?.protector as ContentProtector,
      )
    }
    const assertPlannedAncestors = async (
      descendant: PlannedItem,
    ): Promise<PathIdentity | undefined> => {
      try {
        await assertDirectoryIdentity(
          descendant.externalParent.path,
          descendant.externalParent.identity,
        )
      } catch {
        throw new ApplyFailure(
          'destination',
          'APPLY_TARGET_DRIFT',
          'The bound mapping parent changed before publication',
        )
      }
      let immediateParent =
        resolve(descendant.externalParent.path) === dirname(resolve(descendant.targetPath))
          ? descendant.externalParent.identity
          : undefined
      for (const ancestor of activePlan.items) {
        if (
          ancestor.entry.type !== 'directory' ||
          ancestor.entry.id === descendant.entry.id ||
          !pathUnder(ancestor.targetPath, descendant.targetPath)
        )
          continue
        const current = await lstatIdentity(ancestor.targetPath)
        if (current?.type !== 'directory')
          throw new ApplyFailure(
            'destination',
            'APPLY_TARGET_DRIFT',
            'A planned ancestor changed before descendant publication',
          )
        const progress = activeJournal.items.find(
          (candidate) => candidate.entryId === ancestor.entry.id,
        )
        const expectedDevice = progress?.finalDevice ?? ancestor.expected?.device.toString()
        const expectedInode = progress?.finalInode ?? ancestor.expected?.inode.toString()
        if (
          (progress && progress.status !== 'published' && progress.status !== 'applied') ||
          !expectedDevice ||
          !expectedInode ||
          current.device.toString() !== expectedDevice ||
          current.inode.toString() !== expectedInode
        ) {
          throw new ApplyFailure(
            'destination',
            'APPLY_TARGET_DRIFT',
            'A planned ancestor identity changed before descendant publication',
          )
        }
        if (resolve(ancestor.targetPath) === dirname(resolve(descendant.targetPath)))
          immediateParent = current
      }
      return immediateParent
    }
    const refreshPublishedAncestors = async (publishedItem: PlannedItem): Promise<void> => {
      for (const ancestor of activePlan.items) {
        if (
          ancestor.entry.type !== 'directory' ||
          ancestor.entry.id === publishedItem.entry.id ||
          !pathUnder(ancestor.targetPath, publishedItem.targetPath)
        )
          continue
        const ancestorProgress = activeJournal.items.find(
          (candidate) => candidate.entryId === ancestor.entry.id,
        )
        if (
          !ancestorProgress ||
          (ancestorProgress.status !== 'published' && ancestorProgress.status !== 'applied')
        )
          continue
        const current = await lstatIdentity(ancestor.targetPath)
        if (
          current?.type !== 'directory' ||
          current.device.toString() !== ancestorProgress.finalDevice ||
          current.inode.toString() !== ancestorProgress.finalInode
        )
          throw new ApplyFailure(
            'destination',
            'APPLY_TARGET_DRIFT',
            'A published ancestor identity changed during apply',
          )
        ancestorProgress.finalDevice = current.device.toString()
        ancestorProgress.finalInode = current.inode.toString()
        ancestorProgress.finalSize = current.size.toString()
        ancestorProgress.finalModifiedAtNs = current.modifiedAtNs.toString()
        ancestorProgress.finalChangedAtNs = current.changedAtNs.toString()
      }
    }
    const recordPublished = async (
      progress: JournalItem,
      final: PathIdentity,
      item: PlannedItem,
    ) => {
      progress.status = 'published'
      progress.finalDevice = final.device.toString()
      progress.finalInode = final.inode.toString()
      progress.finalSize = final.size.toString()
      progress.finalModifiedAtNs = final.modifiedAtNs.toString()
      progress.finalChangedAtNs = final.changedAtNs.toString()
      progress.expectedDevice = undefined
      progress.expectedInode = undefined
      progress.expectedSize = undefined
      progress.expectedModifiedAtNs = undefined
      progress.expectedChangedAtNs = undefined
      if (item.entry.type === 'file') {
        await recordHardlinkSiblingExpectations(
          item.entry.id,
          safety,
          activeJournal,
          options.metadata,
        )
      }
      await refreshPublishedAncestors(item)
      await persist()
    }
    for (const item of ordered.filter((candidate) => candidate.entry.type === 'directory')) {
      const progress = journal.items.find(
        (candidate) => candidate.entryId === item.entry.id,
      ) as JournalItem
      try {
        const current = await lstatIdentity(item.targetPath)
        if (progress.status === 'published' && !matchesProgressIdentity(current, progress)) {
          throw new ApplyFailure(
            'destination',
            'APPLY_TARGET_DRIFT',
            'A published target identity changed before resume',
          )
        }
        if (progress.status !== 'published' && progress.status !== 'applied') {
          const safetyEntry = safety.entries.find(
            (candidate) => candidate.entryId === item.entry.id,
          )
          if (!safetyEntry || !(await safetyExpectationMatches(safetyEntry, progress))) {
            throw new ApplyFailure(
              'destination',
              'APPLY_TARGET_DRIFT',
              'A target changed outside the bound apply plan',
            )
          }
          const final = await publishItem(
            { ...item, expected: current },
            options,
            () => assertPlannedAncestors(item),
            () => ensureSafetyEntry(item),
          )
          await recordPublished(progress, final, item)
        }
        await runAfterTargetPublish(item)
      } catch (error) {
        if (error instanceof ApplyInterruption) throw error
        if (error instanceof SafetyResidueError) throw error
        if (progress.status !== 'published') progress.status = 'failed'
        progress.issueCode = error instanceof ApplyFailure ? error.code : 'ITEM_APPLY_FAILED'
        issues.push(failureIssue(error))
        await persist()
      }
    }
    for (const item of ordered.filter((candidate) => candidate.entry.type !== 'directory')) {
      const progress = journal.items.find(
        (candidate) => candidate.entryId === item.entry.id,
      ) as JournalItem
      if (progress.status === 'applied') {
        try {
          await assertPlannedAncestors(item)
          if (!matchesProgressIdentity(await lstatIdentity(item.targetPath), progress))
            throw new ApplyFailure(
              'destination',
              'APPLY_TARGET_DRIFT',
              'An applied target identity changed before resume verification',
            )
          await verifyAppliedItem(item, options.metadata)
        } catch (error) {
          issues.push(failureIssue(error))
        }
        continue
      }
      try {
        const current = await lstatIdentity(item.targetPath)
        if (progress.status === 'published' && !matchesProgressIdentity(current, progress)) {
          throw new ApplyFailure(
            'destination',
            'APPLY_TARGET_DRIFT',
            'A published target identity changed before resume',
          )
        }
        if (await desiredContentPresent({ ...item, expected: current })) {
          if (progress.status !== 'published')
            await recordPublished(progress, current as PathIdentity, item)
        } else {
          const safetyEntry = safety.entries.find(
            (candidate) => candidate.entryId === item.entry.id,
          )
          if (!safetyEntry || !(await safetyExpectationMatches(safetyEntry, progress))) {
            throw new ApplyFailure(
              'destination',
              'APPLY_TARGET_DRIFT',
              'A target changed outside the bound apply plan',
            )
          }
          const final = await publishItem(
            { ...item, expected: current },
            options,
            () => assertPlannedAncestors(item),
            () => ensureSafetyEntry(item),
          )
          await recordPublished(progress, final, item)
        }
        await assertPlannedAncestors(item)
        if (!matchesProgressIdentity(await lstatIdentity(item.targetPath), progress))
          throw new ApplyFailure(
            'destination',
            'APPLY_TARGET_DRIFT',
            'An applied target changed before metadata restoration',
          )
        await runAfterTargetPublish(item)
        await ensureSafetyEntry(item)
        const losses = await restoreMetadata(item.targetPath, item.entry, options.metadata)
        await verifyAppliedContent(item)
        const verificationLosses = await verifyMetadata(
          item.targetPath,
          item.entry,
          options.metadata,
        )
        for (const loss of [...losses, ...verificationLosses]) {
          issues.push(issue(loss.code, 'partial', loss.message))
          progress.issueCode ??= loss.code
        }
        const final = (await lstatIdentity(item.targetPath)) as PathIdentity
        progress.status = losses.length + verificationLosses.length > 0 ? 'published' : 'applied'
        progress.fidelityLoss = losses.length + verificationLosses.length > 0 ? true : undefined
        progress.finalDevice = final.device.toString()
        progress.finalInode = final.inode.toString()
        progress.finalSize = final.size.toString()
        progress.finalModifiedAtNs = final.modifiedAtNs.toString()
        progress.finalChangedAtNs = final.changedAtNs.toString()
        if (item.hardlinkDegraded) {
          issues.push(
            issue(
              'HARDLINK_RELATION_NOT_SELECTED',
              'partial',
              'A selected hardlink was restored as an independent file',
            ),
          )
          progress.issueCode ??= 'HARDLINK_RELATION_NOT_SELECTED'
          progress.fidelityLoss = true
          progress.status = 'published'
        }
        if (item.entry.hardlinkTo && item.hardlinkTargetPath) {
          const anchorProgress = journal.items.find(
            (candidate) => candidate.entryId === item.entry.hardlinkTo,
          )
          const anchorIdentity = await lstatIdentity(item.hardlinkTargetPath)
          if (anchorProgress && anchorIdentity) {
            anchorProgress.finalDevice = anchorIdentity.device.toString()
            anchorProgress.finalInode = anchorIdentity.inode.toString()
            anchorProgress.finalSize = anchorIdentity.size.toString()
            anchorProgress.finalModifiedAtNs = anchorIdentity.modifiedAtNs.toString()
            anchorProgress.finalChangedAtNs = anchorIdentity.changedAtNs.toString()
          }
        }
      } catch (error) {
        if (error instanceof ApplyInterruption) throw error
        if (error instanceof SafetyResidueError) throw error
        if (progress.status !== 'published') progress.status = 'failed'
        progress.issueCode = error instanceof ApplyFailure ? error.code : 'ITEM_APPLY_FAILED'
        issues.push(failureIssue(error))
      }
      await persist()
    }
    for (const item of ordered
      .filter((candidate) => candidate.entry.type === 'directory')
      .sort(
        (left, right) => right.targetPath.split(sep).length - left.targetPath.split(sep).length,
      )) {
      const progress = journal.items.find(
        (candidate) => candidate.entryId === item.entry.id,
      ) as JournalItem
      if (progress.status !== 'published' && progress.status !== 'applied') continue
      try {
        await assertPlannedAncestors(item)
        if (!matchesProgressIdentity(await lstatIdentity(item.targetPath), progress))
          throw new ApplyFailure(
            'destination',
            'APPLY_TARGET_DRIFT',
            'A directory changed before metadata restoration',
          )
        if (progress.status === 'applied') {
          await verifyAppliedItem(item, options.metadata)
          continue
        }
        await ensureSafetyEntry(item)
        const losses = await restoreMetadata(item.targetPath, item.entry, options.metadata)
        const verificationLosses = await verifyMetadata(
          item.targetPath,
          item.entry,
          options.metadata,
        )
        for (const loss of [...losses, ...verificationLosses]) {
          issues.push(issue(loss.code, 'partial', loss.message))
          progress.issueCode ??= loss.code
        }
        const final = (await lstatIdentity(item.targetPath)) as PathIdentity
        progress.status = losses.length + verificationLosses.length > 0 ? 'published' : 'applied'
        progress.fidelityLoss = losses.length + verificationLosses.length > 0 ? true : undefined
        progress.finalDevice = final.device.toString()
        progress.finalInode = final.inode.toString()
        progress.finalSize = final.size.toString()
        progress.finalModifiedAtNs = final.modifiedAtNs.toString()
        progress.finalChangedAtNs = final.changedAtNs.toString()
      } catch (error) {
        if (error instanceof SafetyResidueError) throw error
        progress.issueCode = error instanceof ApplyFailure ? error.code : 'ITEM_APPLY_FAILED'
        issues.push(failureIssue(error))
      }
      await persist()
    }
    await ensureSafetyLease()
    for (const item of plan.items.filter((candidate) => candidate.status !== 'skipped')) {
      try {
        await assertPlannedAncestors(item)
        if (item.status === 'unchanged') {
          if (!samePathIdentity(await lstatIdentity(item.targetPath), item.expected))
            throw new ApplyFailure(
              'destination',
              'APPLY_TARGET_DRIFT',
              'A reviewed unchanged target changed during apply',
            )
          await verifyAppliedItem(item, options.metadata)
          continue
        }
        const progress = journal.items.find((candidate) => candidate.entryId === item.entry.id)
        if (progress?.status === 'applied' || progress?.fidelityLoss) {
          if (!matchesProgressIdentity(await lstatIdentity(item.targetPath), progress))
            throw new ApplyFailure(
              'destination',
              'APPLY_TARGET_DRIFT',
              'An applied target identity changed before final verification',
            )
          await verifyAppliedContent(item)
        }
      } catch (error) {
        if (error instanceof ApplyFailure) issues.push(failureIssue(error))
        else
          issues.push(
            issue(
              'POST_APPLY_VERIFY_FAILED',
              'integrity',
              'Post-apply content verification failed',
            ),
          )
      }
    }
    if (lock) {
      try {
        await lock.release()
        lock = undefined
      } catch {
        issues.push(
          issue('LOCK_RELEASE_FAILED', 'lock', 'Repository lock could not be released safely'),
        )
      }
    }
    const counts = countsFor(plan, journal)
    const failed =
      journal.items.some((item) => item.status !== 'applied' && !item.fidelityLoss) ||
      issues.some(
        (entry) =>
          entry.category === 'integrity' ||
          entry.category === 'destination' ||
          entry.category === 'lock',
      )
    const partial = !failed && issues.some((entry) => entry.category === 'partial')
    const warning = !failed && !partial && plan.items.some((item) => item.status === 'skipped')
    if (warning)
      issues.push(issue('APPLY_ITEMS_SKIPPED', 'warning', 'Some entries were explicitly skipped'))
    if (!failed && !partial && !warning) {
      await ensureSafetyLease()
      await deactivateSafetyProtection({
        stagingPath: options.stagingPath,
        manifest: safety,
        protector: repository.protector,
        reason: 'post-apply-verified',
        now: safeNow(options.now),
      })
    }
    const failureCategory =
      issues.find((entry) => entry.category !== 'partial' && entry.category !== 'warning')
        ?.category ?? 'integrity'
    return {
      operation: 'apply',
      state: failed ? 'failure' : partial ? 'partial' : warning ? 'warning' : 'success',
      category: failed ? failureCategory : partial ? 'partial' : warning ? 'warning' : 'success',
      dryRun: false,
      startedAt: started.toISOString(),
      endedAt: safeNow(options.now).toISOString(),
      repositoryId: staging.repositoryId,
      protection: staging.protection,
      pointId: staging.pointId,
      stagingId: staging.stagingId,
      applyId: plan.applyId,
      safetyId,
      conflictPolicy: plan.policy,
      planFingerprint: plan.fingerprint,
      counts,
      items: resultItems(plan, journal),
      issues,
      nextAction: failed
        ? 'Retry with the same apply ID, or explicitly rollback the Safety Point'
        : partial
          ? 'Retry metadata restoration with the same apply ID, or explicitly rollback the active Safety Point'
          : 'Recovery was verified; the Safety artifact remains but retention protection is inactive',
    }
  } catch (error) {
    const failure = failureIssue(error)
    const failureIssues = [failure]
    if (lock) {
      try {
        await lock.release()
      } catch {
        failureIssues.push(
          issue('LOCK_RELEASE_FAILED', 'lock', 'Repository lock could not be released safely'),
        )
      }
      lock = undefined
    }
    return {
      operation: 'apply',
      state: 'failure',
      category: failure.category,
      dryRun: options.dryRun !== false,
      startedAt: started.toISOString(),
      endedAt: safeNow(options.now).toISOString(),
      repositoryId: options.expectedRepositoryId,
      protection: options.expectedProtection,
      pointId: staging?.pointId ?? '',
      stagingId: staging?.stagingId ?? '',
      applyId: plan?.applyId ?? options.applyId ?? '',
      safetyId,
      conflictPolicy: plan?.policy ?? options.conflictPolicy ?? 'error',
      planFingerprint: plan?.fingerprint ?? '',
      counts: plan ? countsFor(plan, journal) : { ...EMPTY_COUNTS },
      items: plan ? resultItems(plan, journal) : [],
      issues: failureIssues,
      nextAction:
        failure.nextAction ?? 'Resolve the reported issue and retry with the same bound inputs',
    }
  } finally {
    if (safetyLease) await closeSafetyLease(safetyLease).catch(() => undefined)
    await lock?.release().catch(() => undefined)
    repository?.close()
  }
}

async function publishSafetyEntry(
  entry: SafetyEntry,
  manifest: SafetyManifest,
  stagingPath: string,
  protector: ContentProtector,
  deleteNewlyCreated: boolean,
  expectedParent: PathIdentity,
): Promise<PathIdentity | null> {
  const current = await lstatIdentity(entry.targetPath)
  const rebound = await lstatIdentity(entry.targetPath)
  if (
    (current === null) !== (rebound === null) ||
    (current &&
      rebound &&
      (current.device !== rebound.device ||
        current.inode !== rebound.inode ||
        current.type !== rebound.type ||
        current.size !== rebound.size ||
        current.modifiedAtNs !== rebound.modifiedAtNs ||
        current.changedAtNs !== rebound.changedAtNs))
  )
    throw new ApplyFailure(
      'destination',
      'ROLLBACK_TARGET_DRIFT',
      'A rollback target changed before bound publication',
    )
  if (entry.before.state === 'absent') {
    if (!current) return null
    if (!deleteNewlyCreated)
      throw new ApplyFailure(
        'configuration',
        'ROLLBACK_DELETE_CONSENT_REQUIRED',
        'Rollback requires explicit consent to delete newly created entries',
      )
    await deleteEntrySafely(entry.targetPath, current, expectedParent)
    return null
  }
  if (entry.before.type === 'directory') {
    if (current && current.type !== 'directory') throw new Error('rollback type conflict')
    return atomicEnsureDirectory(entry.targetPath, current, expectedParent)
  }
  if (entry.before.type === 'symlink') {
    if (current?.type === 'directory') throw new Error('rollback type conflict')
    await atomicPublish({
      kind: 'symlink',
      destination: entry.targetPath,
      expected: current,
      expectedParent,
      payload: entry.before.linkTarget as string,
    })
  } else {
    if (current?.type === 'directory') throw new Error('rollback type conflict')
    if (entry.before.hardlinkToEntryId) {
      const hardlinkToEntryId = entry.before.hardlinkToEntryId
      const anchor = manifest.entries.find((candidate) => candidate.entryId === hardlinkToEntryId)
      const anchorIdentity = anchor ? await lstatIdentity(anchor.targetPath) : null
      if (!anchor || anchorIdentity?.type !== 'file')
        throw new Error('rollback hardlink anchor missing')
      await atomicPublish({
        kind: 'hardlink',
        destination: entry.targetPath,
        expected: current,
        expectedParent,
        hardlinkSource: { path: anchor.targetPath, identity: anchorIdentity },
      })
    } else {
      const content = await readSafetyBlob(stagingPath, manifest, entry, protector)
      try {
        await atomicPublish({
          kind: 'file',
          destination: entry.targetPath,
          expected: current,
          expectedParent,
          payload: content,
        })
      } finally {
        content.fill(0)
      }
    }
  }
  return lstatIdentity(entry.targetPath)
}

function safetySynthetic(entry: SafetyEntry): StagedEntry | null {
  if (entry.before.state === 'absent') return null
  return {
    id: entry.entryId,
    sourceId: entry.sourceId,
    relativePath: '.',
    type: entry.before.type,
    metadata: entry.before.metadata,
    ...(entry.before.contentHash ? { contentHash: entry.before.contentHash } : {}),
    ...(entry.before.linkTarget !== undefined ? { linkTarget: entry.before.linkTarget } : {}),
    stagingRelativePath: '.',
    selectionRole: 'selected',
  }
}

async function safetyAlreadyRestored(
  entry: SafetyEntry,
  metadata: RollbackOptions['metadata'],
  manifest?: SafetyManifest,
): Promise<boolean> {
  const current = await lstatIdentity(entry.targetPath)
  if (entry.before.state === 'absent') return current === null
  if (!current || current.type !== entry.before.type) return false
  if (entry.before.type === 'file') {
    try {
      const content = await readVerifiedFile(
        entry.targetPath,
        entry.before.plaintextBytes as number,
        entry.before.contentHash as string,
      )
      content.fill(0)
    } catch {
      return false
    }
  } else if (
    entry.before.type === 'symlink' &&
    (await readLinkSafely(entry.targetPath).catch(() => undefined)) !== entry.before.linkTarget
  )
    return false
  if (entry.before.type === 'file' && entry.before.hardlinkToEntryId) {
    const hardlinkToEntryId = entry.before.hardlinkToEntryId
    const anchor = manifest?.entries.find((candidate) => candidate.entryId === hardlinkToEntryId)
    const anchorIdentity = anchor ? await lstatIdentity(anchor.targetPath) : null
    if (
      !anchorIdentity ||
      anchorIdentity.inode !== current.inode ||
      anchorIdentity.device !== current.device
    )
      return false
  }
  return (
    (await verifyMetadata(entry.targetPath, safetySynthetic(entry) as StagedEntry, metadata))
      .length === 0
  )
}

function matchesAppliedIdentity(
  current: PathIdentity | null,
  progress: JournalItem | undefined,
): boolean {
  return Boolean(
    current &&
      (progress?.status === 'applied' || progress?.status === 'published') &&
      current.device.toString() === progress.finalDevice &&
      current.inode.toString() === progress.finalInode &&
      current.size.toString() === progress.finalSize &&
      current.modifiedAtNs.toString() === progress.finalModifiedAtNs &&
      current.changedAtNs.toString() === progress.finalChangedAtNs,
  )
}

async function refreshRollbackOwnedExpectations(
  changed: SafetyEntry,
  manifest: SafetyManifest,
  applyJournal: ApplyJournal,
): Promise<void> {
  const changedProgress = applyJournal.items.find((item) => item.entryId === changed.entryId)
  for (const candidate of manifest.entries) {
    if (candidate.entryId === changed.entryId) continue
    const progress = applyJournal.items.find((item) => item.entryId === candidate.entryId)
    if (!progress || (progress.status !== 'published' && progress.status !== 'applied')) continue
    const sameInode =
      changedProgress?.finalDevice === progress.finalDevice &&
      changedProgress?.finalInode === progress.finalInode
    const ancestor = pathUnder(candidate.targetPath, changed.targetPath)
    if (!sameInode && !ancestor) continue
    const current = await lstatIdentity(candidate.targetPath)
    if (!current) continue
    progress.finalDevice = current.device.toString()
    progress.finalInode = current.inode.toString()
    progress.finalSize = current.size.toString()
    progress.finalModifiedAtNs = current.modifiedAtNs.toString()
    progress.finalChangedAtNs = current.changedAtNs.toString()
  }
}

async function assertRollbackAncestors(
  entry: SafetyEntry,
  manifest: SafetyManifest,
  applyJournal: ApplyJournal,
  rollbackJournal: ApplyJournal,
  allowAuthenticatedAbsentTombstones = false,
): Promise<PathIdentity | undefined> {
  const drift = () =>
    new ApplyFailure(
      'destination',
      'ROLLBACK_TARGET_DRIFT',
      'A bound rollback parent or ancestor changed',
    )
  const external = await assertRollbackExternalParent(entry)
  let immediate =
    resolve(entry.externalParent.path) === dirname(resolve(entry.targetPath)) ? external : undefined
  for (const ancestor of manifest.entries) {
    if (ancestor.entryId === entry.entryId || !pathUnder(ancestor.targetPath, entry.targetPath))
      continue
    const rollbackProgress = rollbackJournal.items.find(
      (candidate) => candidate.entryId === ancestor.entryId,
    )
    const applyProgress = applyJournal.items.find(
      (candidate) => candidate.entryId === ancestor.entryId,
    )
    const expected =
      rollbackProgress?.status === 'published' || rollbackProgress?.status === 'applied'
        ? rollbackProgress
        : applyProgress
    const current = await lstatIdentity(ancestor.targetPath)
    const authenticatedAbsentTombstone =
      ancestor.before.state === 'absent' &&
      (rollbackProgress?.status === 'published' || rollbackProgress?.status === 'applied') &&
      [
        rollbackProgress.finalDevice,
        rollbackProgress.finalInode,
        rollbackProgress.finalSize,
        rollbackProgress.finalModifiedAtNs,
        rollbackProgress.finalChangedAtNs,
      ].every((value) => value === '0')
    if (!current && allowAuthenticatedAbsentTombstones && authenticatedAbsentTombstone) continue
    if (
      current?.type !== 'directory' ||
      !expected ||
      current.device.toString() !== expected.finalDevice ||
      current.inode.toString() !== expected.finalInode
    )
      throw drift()
    if (resolve(ancestor.targetPath) === dirname(resolve(entry.targetPath))) immediate = current
  }
  if (immediate) return immediate
  if (allowAuthenticatedAbsentTombstones) return undefined
  try {
    return await assertSafeDirectory(dirname(entry.targetPath))
  } catch {
    throw drift()
  }
}

async function assertRollbackExternalParent(entry: SafetyEntry): Promise<PathIdentity> {
  try {
    const external = await assertSafeDirectory(entry.externalParent.path)
    if (
      external.device.toString() !== entry.externalParent.device ||
      external.inode.toString() !== entry.externalParent.inode
    )
      throw new Error('mapping parent changed')
    return external
  } catch {
    throw new ApplyFailure(
      'destination',
      'ROLLBACK_TARGET_DRIFT',
      'The authenticated rollback mapping parent changed',
    )
  }
}

export async function rollbackSafetyPoint(options: RollbackOptions): Promise<ApplyResult> {
  const started = safeNow(options.now)
  let repository: RepositoryHandle | undefined
  let lock: RepositoryLock | undefined
  let manifest: SafetyManifest | undefined
  let journal: ApplyJournal | undefined
  const issues: ClassifiedIssue[] = []
  try {
    if (options.dryRun !== false) {
      repository = await openRepository(options.repositoryPath, {
        intent: 'read',
        expectedRepositoryId: options.expectedRepositoryId,
        expectedProtection: options.expectedProtection,
        ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
      })
    } else {
      const opened = await openForMutation(options)
      repository = opened.repository
      lock = opened.lock
    }
    if (!repository.protector)
      throw new ApplyFailure(
        'authentication',
        'ROLLBACK_AUTHENTICATION_REQUIRED',
        'Repository protector is unavailable',
      )
    manifest = await readSafetyPoint(
      options.stagingPath,
      options.safetyId,
      options.expectedRepositoryId,
      repository.protector,
    )
    const authenticated = await authenticateStaging(options, options.stagingPath, options.metadata)
    if (
      authenticated.descriptor.repositoryId !== manifest.repositoryId ||
      authenticated.descriptor.pointId !== manifest.pointId ||
      authenticated.descriptor.stagingId !== manifest.stagingId
    )
      throw new ApplyFailure(
        'integrity',
        'SAFETY_STAGING_MISMATCH',
        'Safety Point does not match authenticated staging',
      )
    const applyJournal = await readJournal(
      options.stagingPath,
      manifest.applyId,
      'restore-apply-journal',
      manifest.repositoryId,
      repository.protector,
    )
    if (!applyJournal || applyJournal.planFingerprint !== manifest.planFingerprint) {
      throw new ApplyFailure(
        'integrity',
        'APPLY_JOURNAL_REQUIRED',
        'Rollback requires the bound apply journal',
      )
    }
    const absent = manifest.entries.filter((entry) => entry.before.state === 'absent')
    if (options.dryRun !== false) {
      if (absent.length > 0 && !options.deleteNewlyCreated)
        issues.push(
          issue(
            'ROLLBACK_DELETE_CONSENT_REQUIRED',
            'warning',
            'Rollback would delete paths created by this apply and needs explicit consent',
          ),
        )
      const items: ApplyItemResult[] = []
      for (const entry of manifest.entries) {
        const progress = applyJournal.items.find((item) => item.entryId === entry.entryId)
        const externalParent = await lstatIdentity(entry.externalParent.path)
        const parentBound = Boolean(
          externalParent?.type === 'directory' &&
            externalParent.device.toString() === entry.externalParent.device &&
            externalParent.inode.toString() === entry.externalParent.inode,
        )
        const already =
          parentBound && (await safetyAlreadyRestored(entry, options.metadata, manifest))
        const matches =
          parentBound && matchesAppliedIdentity(await lstatIdentity(entry.targetPath), progress)
        if (!already && !matches)
          issues.push(
            issue(
              'ROLLBACK_TARGET_DRIFT',
              'destination',
              'A target changed after apply; rollback would refuse it',
            ),
          )
        items.push({
          entryId: `entry-${hash(entry.entryId).slice(0, 16)}`,
          sourceId: entry.sourceId,
          targetLabel: entry.targetLabel,
          status: already ? 'unchanged' : matches ? 'pending' : 'conflicted',
        })
      }
      const conflict = items.some((item) => item.status === 'conflicted')
      return {
        operation: 'rollback',
        state: conflict ? 'failure' : issues.length ? 'warning' : 'success',
        category: conflict ? 'destination' : issues.length ? 'warning' : 'success',
        dryRun: true,
        startedAt: started.toISOString(),
        endedAt: safeNow(options.now).toISOString(),
        repositoryId: manifest.repositoryId,
        protection: manifest.protection,
        pointId: manifest.pointId,
        stagingId: manifest.stagingId,
        applyId: manifest.applyId,
        safetyId: manifest.safetyId,
        conflictPolicy: 'overwrite',
        planFingerprint: manifest.planFingerprint,
        counts: {
          ...EMPTY_COUNTS,
          filesConsidered: manifest.entries.filter(
            (entry) => entry.before.state === 'present' && entry.before.type === 'file',
          ).length,
        },
        items,
        issues,
        nextAction:
          'Review the rollback plan and execute with explicit deletion consent when required',
      }
    }
    if (absent.length > 0 && !options.deleteNewlyCreated)
      throw new ApplyFailure(
        'configuration',
        'ROLLBACK_DELETE_CONSENT_REQUIRED',
        'Rollback needs explicit deletion consent',
      )
    const existingRollbackJournal = await readJournal(
      options.stagingPath,
      manifest.applyId,
      'restore-rollback-journal',
      manifest.repositoryId,
      repository.protector,
      new Set(absent.map((entry) => entry.entryId)),
    )
    journal = existingRollbackJournal ?? {
      formatVersion: 1,
      kind: 'restore-rollback-journal',
      applyId: manifest.applyId,
      safetyId: manifest.safetyId,
      repositoryId: manifest.repositoryId,
      pointId: manifest.pointId,
      stagingId: manifest.stagingId,
      planFingerprint: manifest.planFingerprint,
      conflictPolicy: 'overwrite',
      createdAt: started.toISOString(),
      updatedAt: started.toISOString(),
      items: manifest.entries.map((entry) => ({ entryId: entry.entryId, status: 'pending' })),
    }
    if (
      journal.safetyId !== manifest.safetyId ||
      journal.planFingerprint !== manifest.planFingerprint
    )
      throw new Error('rollback journal mismatch')
    const rollbackEntryIds = journal.items.map((item) => item.entryId).sort()
    const safetyEntryIds = manifest.entries.map((entry) => entry.entryId).sort()
    if (rollbackEntryIds.join('\0') !== safetyEntryIds.join('\0'))
      throw new ApplyFailure(
        'integrity',
        'ROLLBACK_JOURNAL_MISMATCH',
        'Rollback journal entry set does not match authenticated Safety',
      )
    if (!existingRollbackJournal && options.beforeTargetPublish) {
      for (const entry of manifest.entries) await options.beforeTargetPublish(entry.targetPath)
      manifest = await readSafetyPoint(
        options.stagingPath,
        options.safetyId,
        options.expectedRepositoryId,
        repository.protector,
      )
      for (const entry of manifest.entries) {
        await assertRollbackExternalParent(entry)
        const alreadyRestored = await safetyAlreadyRestored(entry, options.metadata, manifest)
        const applied = applyJournal.items.find((item) => item.entryId === entry.entryId)
        if (
          !alreadyRestored &&
          !matchesAppliedIdentity(await lstatIdentity(entry.targetPath), applied)
        )
          throw new ApplyFailure(
            'destination',
            'ROLLBACK_TARGET_DRIFT',
            'A rollback target changed during preflight',
          )
      }
    }
    await writeJournal(options.stagingPath, journal, repository.protector)
    const activeRollbackJournal = journal
    const ordered = [...manifest.entries].sort((left, right) => {
      const leftAbsent = left.before.state === 'absent' ? 0 : 1
      const rightAbsent = right.before.state === 'absent' ? 0 : 1
      const hardlink = (entry: SafetyEntry) =>
        entry.before.state === 'present' &&
        entry.before.type === 'file' &&
        entry.before.hardlinkToEntryId
          ? 1
          : 0
      return (
        leftAbsent - rightAbsent ||
        hardlink(left) - hardlink(right) ||
        right.targetPath.split(sep).length - left.targetPath.split(sep).length
      )
    })
    for (const entry of ordered) {
      const progress = journal.items.find((item) => item.entryId === entry.entryId) as JournalItem
      try {
        const alreadyRestored = await safetyAlreadyRestored(entry, options.metadata, manifest)
        if (alreadyRestored) {
          if (entry.before.state === 'absent') await assertRollbackExternalParent(entry)
          else
            await assertRollbackAncestors(
              entry,
              manifest,
              applyJournal,
              activeRollbackJournal,
              true,
            )
          progress.status = 'applied'
          recordProgressIdentity(progress, await lstatIdentity(entry.targetPath))
          await refreshRollbackOwnedExpectations(entry, manifest, activeRollbackJournal)
        } else {
          const expectedParent = await assertRollbackAncestors(
            entry,
            manifest,
            applyJournal,
            activeRollbackJournal,
          )
          if (!expectedParent)
            throw new ApplyFailure(
              'destination',
              'ROLLBACK_TARGET_DRIFT',
              'A rollback publication parent is missing',
            )
          const current = await lstatIdentity(entry.targetPath)
          if (progress.status === 'applied') {
            throw new ApplyFailure(
              'destination',
              'ROLLBACK_TARGET_DRIFT',
              'A rolled-back target changed after verification',
            )
          }
          if (
            progress.status === 'published' &&
            !(entry.before.state === 'absent'
              ? current === null
              : matchesProgressIdentity(current, progress))
          ) {
            throw new ApplyFailure(
              'destination',
              'ROLLBACK_TARGET_DRIFT',
              'A published rollback target identity changed',
            )
          }
          if (progress.status !== 'published') {
            const applied = applyJournal.items.find((item) => item.entryId === entry.entryId)
            if (!matchesAppliedIdentity(current, applied)) {
              throw new ApplyFailure(
                'destination',
                'ROLLBACK_TARGET_DRIFT',
                'A target changed after apply; rollback refused to overwrite it',
              )
            }
            const final = await publishSafetyEntry(
              entry,
              manifest,
              options.stagingPath,
              repository.protector,
              options.deleteNewlyCreated === true,
              expectedParent,
            )
            progress.status = 'published'
            recordProgressIdentity(progress, final)
            await refreshRollbackOwnedExpectations(entry, manifest, activeRollbackJournal)
            await assertRollbackAncestors(entry, manifest, applyJournal, activeRollbackJournal)
            const rebound = await lstatIdentity(entry.targetPath)
            if (
              entry.before.state === 'absent'
                ? rebound !== null
                : !matchesProgressIdentity(rebound, progress)
            )
              throw new ApplyFailure(
                'destination',
                'ROLLBACK_TARGET_DRIFT',
                'A rollback target changed before journal publication',
              )
            journal.updatedAt = safeNow(options.now).toISOString()
            await writeJournal(options.stagingPath, journal, repository.protector)
            await refreshRollbackOwnedExpectations(entry, manifest, applyJournal)
            applyJournal.updatedAt = safeNow(options.now).toISOString()
            await writeJournal(options.stagingPath, applyJournal, repository.protector)
            await options.afterTargetPublish?.(entry.targetPath)
          }
          if (entry.before.state === 'absent') {
            if (await lstatIdentity(entry.targetPath))
              throw new Error('rollback deletion did not persist')
            progress.status = 'applied'
          } else if (entry.before.type !== 'directory') {
            await assertRollbackAncestors(entry, manifest, applyJournal, activeRollbackJournal)
            if (!matchesProgressIdentity(await lstatIdentity(entry.targetPath), progress))
              throw new ApplyFailure(
                'destination',
                'ROLLBACK_TARGET_DRIFT',
                'A rollback target changed before metadata restoration',
              )
            const synthetic = safetySynthetic(entry) as StagedEntry
            const losses = await restoreMetadata(entry.targetPath, synthetic, options.metadata)
            const verificationLosses = await verifyMetadata(
              entry.targetPath,
              synthetic,
              options.metadata,
            )
            for (const loss of [...losses, ...verificationLosses]) {
              issues.push(issue(loss.code, 'partial', loss.message))
              progress.issueCode ??= loss.code
            }
            if (
              !(await safetyAlreadyRestored(entry, options.metadata, manifest)) &&
              verificationLosses.length === 0
            ) {
              throw new Error('rollback content verification failed')
            }
            const final = (await lstatIdentity(entry.targetPath)) as PathIdentity
            progress.status =
              losses.length + verificationLosses.length > 0 ? 'published' : 'applied'
            progress.fidelityLoss = losses.length + verificationLosses.length > 0 ? true : undefined
            progress.finalDevice = final.device.toString()
            progress.finalInode = final.inode.toString()
            progress.finalSize = final.size.toString()
            progress.finalModifiedAtNs = final.modifiedAtNs.toString()
            progress.finalChangedAtNs = final.changedAtNs.toString()
            await refreshRollbackOwnedExpectations(entry, manifest, activeRollbackJournal)
            await assertRollbackAncestors(entry, manifest, applyJournal, activeRollbackJournal)
            if (!matchesProgressIdentity(await lstatIdentity(entry.targetPath), progress))
              throw new ApplyFailure(
                'destination',
                'ROLLBACK_TARGET_DRIFT',
                'A rollback target changed before metadata journal publication',
              )
          }
        }
      } catch (error) {
        const mappedError =
          error instanceof DirectoryEnsureError
            ? error.outcome === 'drift'
              ? new ApplyFailure(
                  'destination',
                  'ROLLBACK_TARGET_DRIFT',
                  'A rollback directory changed before publication',
                )
              : new ApplyFailure(
                  'integrity',
                  'ROLLBACK_PUBLICATION_AMBIGUOUS',
                  'Rollback directory publication may have completed without acknowledgement',
                  'Inspect the bound destination and retry the same Safety Point',
                )
            : error
        if (progress.status !== 'published') progress.status = 'failed'
        progress.issueCode =
          mappedError instanceof ApplyFailure ? mappedError.code : 'ROLLBACK_ITEM_FAILED'
        issues.push(failureIssue(mappedError))
      }
      journal.updatedAt = safeNow(options.now).toISOString()
      await writeJournal(options.stagingPath, journal, repository.protector)
    }
    for (const entry of ordered
      .filter(
        (candidate) =>
          candidate.before.state === 'present' && candidate.before.type === 'directory',
      )
      .sort(
        (left, right) => right.targetPath.split(sep).length - left.targetPath.split(sep).length,
      )) {
      const progress = journal.items.find((item) => item.entryId === entry.entryId) as JournalItem
      if (progress.status !== 'published') continue
      try {
        await assertRollbackAncestors(entry, manifest, applyJournal, activeRollbackJournal)
        if (!matchesProgressIdentity(await lstatIdentity(entry.targetPath), progress))
          throw new ApplyFailure(
            'destination',
            'ROLLBACK_TARGET_DRIFT',
            'A rollback directory changed before metadata restoration',
          )
        const synthetic = safetySynthetic(entry) as StagedEntry
        const losses = await restoreMetadata(entry.targetPath, synthetic, options.metadata)
        const verificationLosses = await verifyMetadata(
          entry.targetPath,
          synthetic,
          options.metadata,
        )
        for (const loss of [...losses, ...verificationLosses]) {
          issues.push(issue(loss.code, 'partial', loss.message))
          progress.issueCode ??= loss.code
        }
        const final = (await lstatIdentity(entry.targetPath)) as PathIdentity
        progress.status = losses.length + verificationLosses.length > 0 ? 'published' : 'applied'
        progress.fidelityLoss = losses.length + verificationLosses.length > 0 ? true : undefined
        progress.finalDevice = final.device.toString()
        progress.finalInode = final.inode.toString()
        progress.finalSize = final.size.toString()
        progress.finalModifiedAtNs = final.modifiedAtNs.toString()
        progress.finalChangedAtNs = final.changedAtNs.toString()
        await refreshRollbackOwnedExpectations(entry, manifest, activeRollbackJournal)
        await assertRollbackAncestors(entry, manifest, applyJournal, activeRollbackJournal)
        if (!matchesProgressIdentity(await lstatIdentity(entry.targetPath), progress))
          throw new ApplyFailure(
            'destination',
            'ROLLBACK_TARGET_DRIFT',
            'A rollback directory changed before metadata journal publication',
          )
      } catch (error) {
        issues.push(failureIssue(error))
      }
      journal.updatedAt = safeNow(options.now).toISOString()
      await writeJournal(options.stagingPath, journal, repository.protector)
    }
    for (const entry of manifest.entries) {
      if (!(await safetyAlreadyRestored(entry, options.metadata, manifest))) {
        if (!issues.some((candidate) => candidate.category === 'partial')) {
          issues.push(
            issue('POST_ROLLBACK_VERIFY_FAILED', 'integrity', 'Post-rollback verification failed'),
          )
        }
      }
    }
    const items: ApplyItemResult[] = manifest.entries.map((entry) => {
      const progress = journal?.items.find((item) => item.entryId === entry.entryId)
      return {
        entryId: `entry-${hash(entry.entryId).slice(0, 16)}`,
        sourceId: entry.sourceId,
        targetLabel: entry.targetLabel,
        status: progress?.status === 'applied' || progress?.fidelityLoss ? 'applied' : 'failed',
        ...(progress?.issueCode ? { issueCode: progress.issueCode } : {}),
      }
    })
    if (lock) {
      try {
        await lock.release()
        lock = undefined
      } catch {
        issues.push(
          issue('LOCK_RELEASE_FAILED', 'lock', 'Repository lock could not be released safely'),
        )
      }
    }
    const failed =
      journal.items.some((entry) => entry.status !== 'applied' && !entry.fidelityLoss) ||
      issues.some(
        (entry) =>
          entry.category === 'destination' ||
          entry.category === 'integrity' ||
          entry.category === 'lock',
      )
    const partial = !failed && issues.some((entry) => entry.category === 'partial')
    if (!failed && !partial) {
      await deactivateSafetyProtection({
        stagingPath: options.stagingPath,
        manifest,
        protector: repository.protector,
        reason: 'rollback-verified',
        now: safeNow(options.now),
      })
    }
    return {
      operation: 'rollback',
      state: failed ? 'failure' : partial ? 'partial' : 'success',
      category: failed
        ? (issues.find((entry) => entry.category !== 'partial')?.category ?? 'integrity')
        : partial
          ? 'partial'
          : 'success',
      dryRun: false,
      startedAt: started.toISOString(),
      endedAt: safeNow(options.now).toISOString(),
      repositoryId: manifest.repositoryId,
      protection: manifest.protection,
      pointId: manifest.pointId,
      stagingId: manifest.stagingId,
      applyId: manifest.applyId,
      safetyId: manifest.safetyId,
      conflictPolicy: 'overwrite',
      planFingerprint: manifest.planFingerprint,
      counts: {
        ...EMPTY_COUNTS,
        restored: items.filter((item) => item.status === 'applied').length,
        failed: items.filter((item) => item.status === 'failed').length,
      },
      items,
      issues,
      nextAction: failed
        ? 'Retry rollback with the same Safety Point'
        : partial
          ? 'Retry metadata restoration; the Safety Point remains protected'
          : 'Rollback was verified; the Safety artifact remains but retention protection is inactive',
    }
  } catch (error) {
    const failure = failureIssue(error)
    const failureIssues = [failure]
    if (lock) {
      try {
        await lock.release()
      } catch {
        failureIssues.push(
          issue('LOCK_RELEASE_FAILED', 'lock', 'Repository lock could not be released safely'),
        )
      }
      lock = undefined
    }
    return {
      operation: 'rollback',
      state: 'failure',
      category: failure.category,
      dryRun: options.dryRun !== false,
      startedAt: started.toISOString(),
      endedAt: safeNow(options.now).toISOString(),
      repositoryId: options.expectedRepositoryId,
      protection: options.expectedProtection,
      pointId: manifest?.pointId ?? '',
      stagingId: manifest?.stagingId ?? '',
      applyId: manifest?.applyId ?? '',
      safetyId: options.safetyId,
      conflictPolicy: 'overwrite',
      planFingerprint: manifest?.planFingerprint ?? '',
      counts: { ...EMPTY_COUNTS },
      items: [],
      issues: failureIssues,
      nextAction: 'Resolve the reported issue and retry rollback with the same Safety Point',
    }
  } finally {
    await lock?.release().catch(() => undefined)
    repository?.close()
  }
}

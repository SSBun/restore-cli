import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assertDirectoryIdentity,
  assertSafeAbsoluteDirectoryChain,
  atomicEnsureDirectory,
  atomicPublish,
  lstatIdentity,
  readVerifiedFile,
} from '../recovery/safe-io.js'
import type { PathIdentity } from '../recovery/safe-io.js'
import { assertLegacySourceUnchanged, readLegacyRepository } from './legacy.js'
import { LegacyMigrationError } from './types.js'
import type {
  LegacyEntryDescriptor,
  LegacyIssue,
  LegacyRestoreFilePlan,
  LegacyRestoreOptions,
  LegacyRestorePlan,
  LegacyRestoreResult,
} from './types.js'

const RESTORE_LIMITATIONS = [
  'Legacy restore copies regular-file content only; 0.1.x did not preserve complete v1 metadata.',
  'Original-location restore is intentionally unavailable; an explicit staging destination is required.',
  'Existing destination files are never overwritten and destination entries are never deleted.',
] as const

export interface LegacyRestoreDependencies {
  /** Test-only race hook after the atomic worker has bound the destination parent. */
  beforeDestinationCommit?: (file: LegacyRestoreFilePlan) => void | Promise<void>
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function validateDestination(path: string, legacyRoot: string): string {
  if (!isAbsolute(path)) {
    throw new LegacyMigrationError(
      'RESTORE_DESTINATION_NOT_ABSOLUTE',
      'integrity',
      'Legacy restore destination must be an explicit absolute path',
    )
  }
  const destination = resolve(path)
  const broad = new Set([resolve('/'), resolve('/Users'), resolve(homedir())])
  if (broad.has(destination)) {
    throw new LegacyMigrationError(
      'RESTORE_DESTINATION_TOO_BROAD',
      'integrity',
      'Legacy restore destination cannot be root, /Users, or the full home directory',
    )
  }
  if (isContained(legacyRoot, destination) || isContained(destination, legacyRoot)) {
    throw new LegacyMigrationError(
      'RESTORE_DESTINATION_OVERLAPS_SOURCE',
      'integrity',
      'Legacy restore destination cannot contain or be contained by the legacy source',
    )
  }
  return destination
}

function normalizedSelections(originalPaths: string[] | undefined): string[] {
  if (!originalPaths) return []
  const selected = new Set<string>()
  for (const path of originalPaths) {
    if (!isAbsolute(path) || resolve(path) !== path || path === '/') {
      throw new LegacyMigrationError(
        'INVALID_LEGACY_SELECTION',
        'integrity',
        'Legacy restore selections must be normalized absolute paths below root',
      )
    }
    selected.add(path.slice(1))
  }
  return [...selected].sort()
}

function selectedEntry(entry: LegacyEntryDescriptor, selections: readonly string[]): boolean {
  if (entry.type !== 'file' || !entry.contentHash) return false
  if (selections.length === 0) return true
  return selections.some(
    (selection) =>
      entry.relativePath === selection || entry.relativePath.startsWith(`${selection}/`),
  )
}

function planDigest(plan: Omit<LegacyRestorePlan, 'planDigest'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        source: plan.source,
        destination: plan.destination,
        files: plan.files.map(({ sourcePath: _sourcePath, ...file }) => file),
        totalBytes: plan.totalBytes,
        limitations: plan.limitations,
      }),
    )
    .digest('hex')
}

export async function planLegacyRestore(options: LegacyRestoreOptions): Promise<LegacyRestorePlan> {
  const before = await readLegacyRepository(options.legacyRepositoryPath, {
    ...(options.system ? { system: options.system } : {}),
  })
  let canonicalDestination: string
  try {
    canonicalDestination = await realpath(options.destinationPath)
  } catch {
    throw new LegacyMigrationError(
      'RESTORE_DESTINATION_MISSING',
      'integrity',
      'Explicit legacy restore destination must already exist',
    )
  }
  const destinationPath = validateDestination(canonicalDestination, before.rootPath)
  let destinationIdentity: PathIdentity
  try {
    destinationIdentity = await assertSafeAbsoluteDirectoryChain(destinationPath)
  } catch {
    throw new LegacyMigrationError(
      'RESTORE_DESTINATION_UNSAFE',
      'integrity',
      'Explicit restore destination chain must contain only no-follow directories',
    )
  }
  const point = before.points.find((candidate) => candidate.id === options.pointId)
  if (!point) {
    throw new LegacyMigrationError(
      'LEGACY_POINT_NOT_FOUND',
      'integrity',
      'Selected legacy recovery point does not exist',
    )
  }
  if (!point.migratable) {
    throw new LegacyMigrationError(
      'LEGACY_POINT_UNSUPPORTED',
      'unsupported',
      'Selected legacy recovery point contains unsupported entries',
    )
  }
  const selections = normalizedSelections(options.originalPaths)
  const files: LegacyRestoreFilePlan[] = point.entries
    .filter((entry) => selectedEntry(entry, selections))
    .map((entry) => ({
      sourcePath: join(point.path, entry.relativePath),
      relativePath: entry.relativePath,
      destinationPath: join(destinationPath, entry.relativePath),
      bytes: entry.size,
      contentHash: entry.contentHash as string,
    }))
  if (selections.length > 0) {
    const matched = new Set(
      selections.filter((selection) =>
        files.some(
          (file) =>
            file.relativePath === selection || file.relativePath.startsWith(`${selection}/`),
        ),
      ),
    )
    if (matched.size !== selections.length) {
      throw new LegacyMigrationError(
        'LEGACY_SELECTION_NOT_FOUND',
        'integrity',
        'One or more selected original paths are not present in the legacy point',
      )
    }
  }
  const withoutDigest: Omit<LegacyRestorePlan, 'planDigest'> = {
    operation: 'legacy-restore',
    dryRun: options.dryRun !== false,
    source: {
      repositoryPath: before.rootPath,
      repositoryDigest: before.digest,
      repositoryIdentityDigest: before.identityDigest,
      pointId: point.id,
      pointDigest: point.digest,
      pointIdentityDigest: point.identityDigest,
      readOnly: true,
    },
    destination: {
      path: destinationPath,
      device: destinationIdentity.device.toString(),
      inode: destinationIdentity.inode.toString(),
      overwrite: false,
      deletes: false,
      atomicFiles: true,
    },
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    limitations: [...RESTORE_LIMITATIONS],
  }
  const result: LegacyRestorePlan = { ...withoutDigest, planDigest: planDigest(withoutDigest) }
  const after = await readLegacyRepository(options.legacyRepositoryPath, {
    ...(options.system ? { system: options.system } : {}),
  })
  assertLegacySourceUnchanged(before, after)
  return result
}

async function ensureParentDirectories(
  destinationRoot: string,
  destinationPath: string,
  rootIdentity: PathIdentity,
): Promise<PathIdentity> {
  const relativeParent = relative(destinationRoot, dirname(destinationPath))
  if (relativeParent === '' || relativeParent === '.') {
    await assertDirectoryIdentity(destinationRoot, rootIdentity)
    return rootIdentity
  }
  let current = destinationRoot
  let parentIdentity = rootIdentity
  for (const component of relativeParent.split(sep)) {
    if (!component || component === '.' || component === '..') {
      throw new LegacyMigrationError(
        'RESTORE_DESTINATION_ESCAPE',
        'integrity',
        'Restore file would escape the explicit destination',
      )
    }
    await assertDirectoryIdentity(current, parentIdentity)
    const child = join(current, component)
    try {
      const expected = await lstatIdentity(child)
      if (expected && expected.type !== 'directory') throw new Error('not a directory')
      parentIdentity = await atomicEnsureDirectory(child, expected, parentIdentity)
      current = child
    } catch {
      throw new LegacyMigrationError(
        'RESTORE_DESTINATION_CHANGED',
        'integrity',
        'Restore destination parent changed or is unsafe',
      )
    }
  }
  return parentIdentity
}

async function publishAtomicFile(
  file: LegacyRestoreFilePlan,
  destinationRoot: string,
  rootIdentity: PathIdentity,
  dependencies: LegacyRestoreDependencies,
): Promise<'published' | 'already-present'> {
  if (!isContained(destinationRoot, file.destinationPath)) {
    throw new LegacyMigrationError(
      'RESTORE_DESTINATION_ESCAPE',
      'integrity',
      'Restore file would escape the explicit destination',
    )
  }
  const parentIdentity = await ensureParentDirectories(
    destinationRoot,
    file.destinationPath,
    rootIdentity,
  )
  const existing = await lstatIdentity(file.destinationPath)
  if (existing) {
    try {
      if (existing.type !== 'file') throw new Error('not a file')
      const reconciled = await readVerifiedFile(file.destinationPath, file.bytes, file.contentHash)
      reconciled.fill(0)
      await assertDirectoryIdentity(destinationRoot, rootIdentity)
      return 'already-present'
    } catch {
      throw new LegacyMigrationError(
        'RESTORE_DESTINATION_CONFLICT',
        'integrity',
        'Existing destination content does not exactly match the approved restore plan',
      )
    }
  }
  let content: Buffer
  try {
    content = await readVerifiedFile(file.sourcePath, file.bytes, file.contentHash)
  } catch {
    throw new LegacyMigrationError(
      'LEGACY_SOURCE_CHANGED',
      'source',
      'Legacy source file changed or could not be verified before restore',
    )
  }
  try {
    await atomicPublish({
      kind: 'file',
      destination: file.destinationPath,
      expected: null,
      expectedParent: parentIdentity,
      payload: content,
      ...(dependencies.beforeDestinationCommit
        ? { beforeCommit: () => dependencies.beforeDestinationCommit?.(file) }
        : {}),
    })
    await assertDirectoryIdentity(destinationRoot, rootIdentity)
    return 'published'
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error
    throw new LegacyMigrationError(
      'RESTORE_DESTINATION_CHANGED',
      'integrity',
      'Restore destination changed before atomic file publication',
    )
  } finally {
    content.fill(0)
  }
}

function restoreIssue(error: unknown): LegacyIssue {
  if (error instanceof LegacyMigrationError) {
    return { code: error.code, category: error.category, message: error.message }
  }
  return {
    code: 'LEGACY_RESTORE_FAILED',
    category: 'integrity',
    message: 'Legacy restore did not complete safely',
  }
}

function restoreCounts(
  plan: LegacyRestorePlan,
  filesWritten: number,
  filesReconciled: number,
  bytesRead: number,
  bytesWritten: number,
  failure: boolean,
) {
  const completed = filesWritten + filesReconciled
  const remaining = Math.max(0, plan.files.length - completed)
  const filesFailed = failure && remaining > 0 ? 1 : 0
  return {
    filesConsidered: plan.files.length,
    filesWritten,
    filesSkipped: filesReconciled + (failure ? Math.max(0, remaining - filesFailed) : 0),
    filesFailed,
    bytesRead,
    bytesWritten,
  }
}

export async function restoreLegacyRecoveryPoint(
  options: LegacyRestoreOptions,
  dependencies: LegacyRestoreDependencies = {},
): Promise<LegacyRestoreResult> {
  const startedAt = new Date().toISOString()
  const plan = await planLegacyRestore(options)
  if (plan.dryRun) {
    return {
      ...plan,
      startedAt,
      endedAt: new Date().toISOString(),
      state: 'success',
      category: 'success',
      counts: restoreCounts(plan, 0, 0, 0, 0, false),
      verificationScope: 'structural',
      filesRestored: 0,
      bytesRestored: 0,
      issues: [],
    }
  }
  if (options.approvedPlanDigest !== plan.planDigest) {
    return {
      ...plan,
      startedAt,
      endedAt: new Date().toISOString(),
      state: 'failure',
      category: 'configuration',
      counts: restoreCounts(plan, 0, 0, 0, 0, true),
      verificationScope: 'structural',
      filesRestored: 0,
      bytesRestored: 0,
      issues: [
        {
          code: 'LEGACY_RESTORE_DRY_RUN_REQUIRED',
          category: 'configuration',
          message: 'Execute requires the matching plan digest from a prior dry-run',
        },
      ],
    }
  }

  const before = await readLegacyRepository(options.legacyRepositoryPath, {
    ...(options.system ? { system: options.system } : {}),
  })
  let restored = 0
  let reconciled = 0
  let bytesRestored = 0
  let bytesWritten = 0
  try {
    const approvedPoint = before.points.find((point) => point.id === plan.source.pointId)
    if (
      before.digest !== plan.source.repositoryDigest ||
      before.identityDigest !== plan.source.repositoryIdentityDigest ||
      !approvedPoint ||
      approvedPoint.digest !== plan.source.pointDigest ||
      approvedPoint.identityDigest !== plan.source.pointIdentityDigest
    ) {
      throw new LegacyMigrationError(
        'LEGACY_SOURCE_CHANGED_AFTER_APPROVAL',
        'source',
        'Legacy source changed after the approved plan was reproduced',
      )
    }
    let rootIdentity: PathIdentity
    try {
      rootIdentity = await assertSafeAbsoluteDirectoryChain(plan.destination.path)
    } catch {
      throw new LegacyMigrationError(
        'RESTORE_DESTINATION_UNSAFE',
        'integrity',
        'Explicit restore destination chain must contain only no-follow directories',
      )
    }
    if (
      rootIdentity.device.toString() !== plan.destination.device ||
      rootIdentity.inode.toString() !== plan.destination.inode
    ) {
      throw new LegacyMigrationError(
        'RESTORE_DESTINATION_CHANGED_AFTER_APPROVAL',
        'integrity',
        'Restore destination identity changed after plan approval',
      )
    }
    for (const file of plan.files) {
      const publication = await publishAtomicFile(
        file,
        plan.destination.path,
        rootIdentity,
        dependencies,
      )
      if (publication === 'published') {
        restored++
        bytesWritten += file.bytes
      } else reconciled++
      bytesRestored += file.bytes
    }
    const after = await readLegacyRepository(options.legacyRepositoryPath, {
      ...(options.system ? { system: options.system } : {}),
    })
    assertLegacySourceUnchanged(before, after)
    return {
      ...plan,
      startedAt,
      endedAt: new Date().toISOString(),
      state: 'success',
      category: 'success',
      counts: restoreCounts(plan, restored, reconciled, bytesRestored, bytesWritten, false),
      verificationScope: 'content',
      filesRestored: restored + reconciled,
      bytesRestored,
      issues: [],
    }
  } catch (error) {
    return {
      ...plan,
      startedAt,
      endedAt: new Date().toISOString(),
      state: 'failure',
      category: error instanceof LegacyMigrationError ? error.category : 'internal',
      counts: restoreCounts(plan, restored, reconciled, bytesRestored, bytesWritten, true),
      verificationScope: 'structural',
      filesRestored: restored + reconciled,
      bytesRestored,
      issues: [restoreIssue(error)],
    }
  }
}

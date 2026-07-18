import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { ProtectionAuthenticationError, ProtectionError } from '../protection/errors.js'
import { RepositoryError, openRepository as defaultOpenRepository } from '../repository/index.js'
import type {
  ClassifiedIssue,
  OperationCategory,
  OperationState,
  RepositoryHandle,
} from '../repository/index.js'
import { readBoundedRegularFile } from '../repository/io.js'
import { discoverVisiblePoints } from './discovery.js'
import type {
  DiscoveredPoint,
  PointDiscoveryDiagnostic,
  PointVerificationResult,
  RecoveryPointManifestV1,
  VerificationCoverage,
  VerificationReport,
  VerifyV1Options,
} from './types.js'
import {
  MAX_PROTECTED_BLOB_BYTES,
  MAX_PROTECTED_MANIFEST_BYTES,
  POINT_ID_PATTERN,
} from './types.js'
import {
  V1ValidationError,
  assertDescriptorManifestAgreement,
  parseRecoveryPointManifestV1,
} from './validation.js'

interface DirectoryIdentity {
  path: string
  device: bigint
  inode: bigint
  handle: Awaited<ReturnType<typeof open>>
}

class ReadGuard {
  readonly #directories: DirectoryIdentity[] = []

  async hold(path: string, expected?: { device: bigint; inode: bigint }): Promise<void> {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      const held = await handle.stat({ bigint: true })
      const current = await lstat(path, { bigint: true })
      if (
        !held.isDirectory() ||
        !current.isDirectory() ||
        held.dev !== current.dev ||
        held.ino !== current.ino ||
        (expected && (held.dev !== expected.device || held.ino !== expected.inode))
      ) {
        throw new Error('unsafe directory')
      }
      this.#directories.push({ path, device: held.dev, inode: held.ino, handle })
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  async assertStable(): Promise<void> {
    for (const directory of this.#directories) {
      const held = await directory.handle.stat({ bigint: true })
      const current = await lstat(directory.path, { bigint: true })
      if (
        !held.isDirectory() ||
        !current.isDirectory() ||
        held.dev !== directory.device ||
        held.ino !== directory.inode ||
        current.dev !== directory.device ||
        current.ino !== directory.inode
      ) {
        throw new Error('directory identity changed')
      }
    }
  }

  async close(): Promise<void> {
    for (const directory of this.#directories.reverse()) {
      await directory.handle.close().catch(() => undefined)
    }
  }
}

function issue(
  code: string,
  category: ClassifiedIssue['category'],
  message: string,
  nextAction = 'Inspect the affected recovery point and keep it out of restore selection',
): ClassifiedIssue {
  return { code, category, message, nextAction }
}

function classify(error: unknown): ClassifiedIssue {
  if (error instanceof ProtectionAuthenticationError) {
    return issue(
      'AUTHENTICATION_FAILED',
      'authentication',
      'Repository credentials could not authenticate protected metadata or content',
      'Unlock the repository with a valid credential and run verify again',
    )
  }
  if (error instanceof ProtectionError) {
    return issue(
      error.code,
      error.code === 'AUTHENTICATION_FAILED' ? 'authentication' : 'integrity',
      'Protected recovery point content is invalid',
    )
  }
  if (error instanceof RepositoryError) {
    return issue(error.code, error.category, error.message)
  }
  if (error instanceof V1ValidationError) {
    return issue(error.code, 'integrity', error.message)
  }
  return issue('POINT_VERIFICATION_FAILED', 'integrity', 'Recovery point verification failed')
}

async function inspectRegularFile(
  path: string,
  expectedSize: number,
  guard: ReadGuard,
  expectedIdentity?: { device: bigint; inode: bigint },
): Promise<{ device: bigint; inode: bigint }> {
  await guard.assertStable()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await file.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    await guard.assertStable()
    if (
      !opened.isFile() ||
      !current.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size !== current.size ||
      opened.size !== BigInt(expectedSize) ||
      (expectedIdentity &&
        (opened.dev !== expectedIdentity.device || opened.ino !== expectedIdentity.inode))
    ) {
      throw new V1ValidationError('INVALID_BLOB_OBJECT')
    }
    return { device: opened.dev, inode: opened.ino }
  } finally {
    await file.close().catch(() => undefined)
  }
}

async function assertExactPointLayout(
  point: DiscoveredPoint,
  manifest: RecoveryPointManifestV1,
  guard: ReadGuard,
): Promise<void> {
  await guard.assertStable()
  const boundedNames = async (path: string, maximum: number): Promise<string[]> => {
    const names: string[] = []
    const directory = await opendir(path)
    try {
      for await (const entry of directory) {
        if (names.length >= maximum) throw new V1ValidationError('POINT_LAYOUT_TOO_LARGE')
        names.push(entry.name)
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
    return names.sort()
  }
  const pointEntries = await boundedNames(point.path, 4)
  const expectedPointEntries = ['blobs', point.descriptor.manifest, 'point.json'].sort()
  if (
    pointEntries.length !== expectedPointEntries.length ||
    pointEntries.some((name, index) => name !== expectedPointEntries[index])
  ) {
    throw new V1ValidationError('INVALID_POINT_LAYOUT')
  }
  const blobsPath = join(point.path, 'blobs')
  const blobMetadata = await lstat(blobsPath)
  if (!blobMetadata.isDirectory() || blobMetadata.isSymbolicLink()) {
    throw new V1ValidationError('INVALID_POINT_LAYOUT')
  }
  const actualBlobs = await boundedNames(blobsPath, manifest.blobs.length + 1)
  const expectedBlobs = manifest.blobs.map((blob) => blob.id).sort()
  if (
    actualBlobs.length !== expectedBlobs.length ||
    actualBlobs.some((name, index) => name !== expectedBlobs[index])
  ) {
    throw new V1ValidationError('INVALID_POINT_LAYOUT')
  }
  await guard.assertStable()
}

function pointFailure(
  pointId: string,
  completedAt: string | null,
  failure: ClassifiedIssue,
  counts: Partial<PointVerificationResult> = {},
): PointVerificationResult {
  return {
    pointId,
    completedAt,
    manifestHealth: null,
    state: 'failure',
    category: failure.category,
    structurallyHealthy: false,
    contentHealthy: null,
    filesConsidered: 0,
    filesVerified: 0,
    filesSkipped: 0,
    filesFailed: 0,
    bytesConsidered: 0,
    bytesVerified: 0,
    bytesSkipped: 0,
    bytesFailed: 0,
    ...counts,
    issues: [failure],
  }
}

async function verifyPoint(
  repository: RepositoryHandle,
  point: DiscoveredPoint,
  scope: 'structural' | 'content',
): Promise<PointVerificationResult> {
  const guard = new ReadGuard()
  let manifest: RecoveryPointManifestV1 | undefined
  const verifiedEntryIds = new Set<string>()
  try {
    await guard.hold(repository.layout.points)
    await guard.hold(point.path, { device: point.device, inode: point.inode })
    const manifestPath = join(point.path, point.descriptor.manifest)
    const protectedManifest = await readBoundedRegularFile(
      manifestPath,
      MAX_PROTECTED_MANIFEST_BYTES,
    )
    await guard.assertStable()
    if (!repository.protector) throw new ProtectionAuthenticationError()
    let plaintext: Buffer | undefined
    try {
      try {
        plaintext = await repository.protector.open(protectedManifest, {
          repositoryId: repository.descriptor.repositoryId,
          purpose: 'manifest',
          objectId: point.id,
        })
      } catch (error) {
        if (error instanceof ProtectionAuthenticationError) {
          throw new V1ValidationError('MANIFEST_AUTHENTICATION_FAILED')
        }
        throw error
      }
      if (plaintext.length > MAX_PROTECTED_MANIFEST_BYTES) {
        throw new V1ValidationError('POINT_MANIFEST_TOO_LARGE')
      }
      manifest = parseRecoveryPointManifestV1(JSON.parse(plaintext.toString('utf8')))
    } catch (error) {
      if (error instanceof SyntaxError) throw new V1ValidationError('INVALID_POINT_MANIFEST')
      throw error
    } finally {
      protectedManifest.fill(0)
      plaintext?.fill(0)
    }
    assertDescriptorManifestAgreement(
      point.descriptor,
      manifest,
      basename(point.path),
      repository.descriptor.repositoryId,
      repository.descriptor.protection,
    )

    await assertExactPointLayout(point, manifest, guard)
    await guard.hold(join(point.path, 'blobs'))
    const hardlinksByTarget = new Map<string, string[]>()
    const blobIdentities = new Map<string, { device: bigint; inode: bigint }>()
    for (const entry of manifest.entries) {
      if (!entry.hardlinkTo) continue
      const linked = hardlinksByTarget.get(entry.hardlinkTo) ?? []
      linked.push(entry.id)
      hardlinksByTarget.set(entry.hardlinkTo, linked)
    }
    for (const blob of manifest.blobs) {
      const blobPath = join(point.path, blob.path)
      blobIdentities.set(blob.id, await inspectRegularFile(blobPath, blob.protectedBytes, guard))
      if (scope === 'structural') continue
      const protectedContent = await readBoundedRegularFile(blobPath, MAX_PROTECTED_BLOB_BYTES)
      await guard.assertStable()
      let plaintext: Buffer | undefined
      try {
        try {
          plaintext = await repository.protector.open(protectedContent, {
            repositoryId: repository.descriptor.repositoryId,
            purpose: 'blob',
            objectId: blob.id,
          })
        } catch (error) {
          if (error instanceof ProtectionAuthenticationError) {
            throw new V1ValidationError('BLOB_AUTHENTICATION_FAILED')
          }
          throw error
        }
        if (
          plaintext.length !== blob.plaintextBytes ||
          createHash('sha256').update(plaintext).digest('hex') !== blob.contentHash
        ) {
          throw new V1ValidationError('BLOB_CONTENT_MISMATCH')
        }
        verifiedEntryIds.add(blob.entryId)
        for (const entryId of hardlinksByTarget.get(blob.entryId) ?? []) {
          verifiedEntryIds.add(entryId)
        }
      } finally {
        protectedContent.fill(0)
        plaintext?.fill(0)
      }
    }
    for (const blob of manifest.blobs) {
      await inspectRegularFile(
        join(point.path, blob.path),
        blob.protectedBytes,
        guard,
        blobIdentities.get(blob.id),
      )
    }
    await guard.assertStable()
    const fileEntries = manifest.entries.filter((entry) => entry.type === 'file')
    const filesConsidered = fileEntries.length
    const bytesConsidered = fileEntries.reduce((total, entry) => total + entry.metadata.size, 0)
    return {
      pointId: point.id,
      completedAt: point.descriptor.completedAt,
      manifestHealth: manifest.health,
      state: manifest.health === 'healthy' ? 'success' : 'partial',
      category: manifest.health === 'healthy' ? 'success' : 'partial',
      structurallyHealthy: true,
      contentHealthy: scope === 'content' ? true : null,
      filesConsidered,
      filesVerified: scope === 'content' ? verifiedEntryIds.size : filesConsidered,
      filesSkipped: 0,
      filesFailed: 0,
      bytesConsidered,
      bytesVerified:
        scope === 'content'
          ? fileEntries
              .filter((entry) => verifiedEntryIds.has(entry.id))
              .reduce((total, entry) => total + entry.metadata.size, 0)
          : bytesConsidered,
      bytesSkipped: 0,
      bytesFailed: 0,
      issues:
        manifest.health === 'healthy'
          ? []
          : [
              issue(
                'POINT_PARTIAL',
                'partial',
                'Recovery point records incomplete or reduced-fidelity capture',
                'Choose a healthy recovery point for restore',
              ),
            ],
    }
  } catch (error) {
    const failure = classify(error)
    const fileEntries = manifest?.entries.filter((entry) => entry.type === 'file') ?? []
    const filesConsidered = fileEntries.length
    const bytesConsidered = fileEntries.reduce((total, entry) => total + entry.metadata.size, 0)
    const filesVerified = verifiedEntryIds.size
    const bytesVerified = fileEntries
      .filter((entry) => verifiedEntryIds.has(entry.id))
      .reduce((total, entry) => total + entry.metadata.size, 0)
    return pointFailure(point.id, point.descriptor.completedAt, failure, {
      manifestHealth: manifest?.health ?? null,
      filesConsidered,
      filesVerified,
      filesFailed: Math.max(0, filesConsidered - filesVerified),
      bytesConsidered,
      bytesVerified,
      bytesFailed: Math.max(0, bytesConsidered - bytesVerified),
      contentHealthy: scope === 'content' ? false : null,
    })
  } finally {
    await guard.close()
  }
}

function malformedPointResult(diagnostic: PointDiscoveryDiagnostic): PointVerificationResult {
  return pointFailure(
    diagnostic.pointId ?? diagnostic.name,
    null,
    issue(diagnostic.code, 'integrity', diagnostic.message),
  )
}

function aggregateCoverage(points: readonly PointVerificationResult[]): VerificationCoverage {
  const sum = (field: keyof PointVerificationResult) =>
    points.reduce(
      (total, point) => total + (typeof point[field] === 'number' ? (point[field] as number) : 0),
      0,
    )
  const coverage = {
    pointsConsidered: points.length,
    pointsVerified: points.filter((point) => point.structurallyHealthy).length,
    pointsSkipped: 0,
    pointsFailed: points.filter((point) => !point.structurallyHealthy).length,
    filesConsidered: sum('filesConsidered'),
    filesVerified: sum('filesVerified'),
    filesSkipped: sum('filesSkipped'),
    filesFailed: sum('filesFailed'),
    bytesConsidered: sum('bytesConsidered'),
    bytesVerified: sum('bytesVerified'),
    bytesSkipped: sum('bytesSkipped'),
    bytesFailed: sum('bytesFailed'),
    complete: points.length > 0 && points.every((point) => point.state === 'success'),
  }
  return coverage
}

function outcome(points: readonly PointVerificationResult[]): {
  state: OperationState
  category: OperationCategory
} {
  const failed = points.find((point) => point.state === 'failure')
  if (failed) return { state: 'failure', category: failed.category }
  if (points.some((point) => point.state === 'partial'))
    return { state: 'partial', category: 'partial' }
  return { state: 'success', category: 'success' }
}

function safeNow(now?: () => Date): Date {
  const value = now?.() ?? new Date()
  if (!Number.isFinite(value.getTime())) throw new Error('invalid time')
  return value
}

function failedReport(
  options: VerifyV1Options,
  started: Date,
  failure: ClassifiedIssue,
): VerificationReport {
  const ended = safeNow(options.now)
  const coverage = aggregateCoverage([])
  return {
    operation: 'verify',
    scope: options.scope,
    verificationScope: options.scope,
    selector: options.selector,
    resolvedPointIds: [],
    resolvedPointId: null,
    repositoryId: options.expectedRepositoryId,
    protection: options.expectedProtection,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    durationMs: Math.max(0, ended.getTime() - started.getTime()),
    cost: options.scope === 'content' ? 'high' : 'low',
    state: 'failure',
    category: failure.category,
    ...coverage,
    coverage,
    points: [],
    issues: [failure],
    nextAction: failure.nextAction ?? null,
  }
}

export async function verifyV1Repository(options: VerifyV1Options): Promise<VerificationReport> {
  const started = safeNow(options.now)
  let repository: RepositoryHandle | undefined
  try {
    if (options.selector.kind === 'point' && !POINT_ID_PATTERN.test(options.selector.pointId)) {
      return failedReport(
        options,
        started,
        issue('INVALID_POINT_ID', 'configuration', 'Recovery point selector is invalid'),
      )
    }
    const opener = options.openRepository ?? defaultOpenRepository
    try {
      repository = await opener(options.repositoryPath, {
        intent: 'read',
        expectedRepositoryId: options.expectedRepositoryId,
        expectedProtection: options.expectedProtection,
        ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
      })
    } catch (error) {
      return failedReport(options, started, classify(error))
    }
    if (repository.descriptor.protection === 'encrypted' && !repository.protector) {
      return failedReport(
        options,
        started,
        issue(
          'REPOSITORY_AUTHENTICATION_FAILED',
          'authentication',
          'Encrypted repository is locked',
          'Unlock the repository with a valid credential and run verify again',
        ),
      )
    }
    const discovery = await discoverVisiblePoints(repository).catch(() => undefined)
    if (!discovery) {
      return failedReport(
        options,
        started,
        issue(
          'POINT_DISCOVERY_FAILED',
          'integrity',
          'Recovery points could not be discovered safely',
        ),
      )
    }

    let selected: DiscoveredPoint[] = []
    let malformed: PointDiscoveryDiagnostic[] = []
    if (options.selector.kind === 'all') {
      selected = discovery.points
      malformed = discovery.diagnostics
    } else if (options.selector.kind === 'point') {
      const pointId = options.selector.pointId
      selected = discovery.points.filter((point) => point.id === pointId)
      malformed = discovery.diagnostics.filter(
        (entry) => entry.pointId === pointId || entry.name === pointId,
      )
      if (selected.length === 0 && malformed.length === 0) {
        return failedReport(
          options,
          started,
          issue('POINT_NOT_FOUND', 'integrity', 'Selected recovery point does not exist'),
        )
      }
    } else if (options.selector.kind === 'latest') {
      if (discovery.points[0]) selected = [discovery.points[0]]
      else if (discovery.diagnostics.length > 0) malformed = discovery.diagnostics
      else {
        return failedReport(
          options,
          started,
          issue('NO_RECOVERY_POINTS', 'integrity', 'Repository has no published recovery points'),
        )
      }
    } else {
      const selectionIssues: ClassifiedIssue[] = []
      for (const point of discovery.points) {
        const inspected = await verifyPoint(repository, point, 'structural')
        if (inspected.structurallyHealthy && inspected.manifestHealth === 'healthy') {
          selected = [point]
          break
        }
        selectionIssues.push(...inspected.issues)
      }
      if (selected.length === 0) {
        const failure =
          selectionIssues.find((entry) => entry.category === 'authentication') ??
          selectionIssues.find((entry) => entry.category === 'integrity') ??
          issue(
            'NO_HEALTHY_RECOVERY_POINT',
            'integrity',
            'Repository has no strictly healthy recovery point',
          )
        return failedReport(options, started, failure)
      }
    }

    const verified: PointVerificationResult[] = []
    for (const point of selected) {
      verified.push(await verifyPoint(repository as RepositoryHandle, point, options.scope))
    }
    const points = [...verified, ...malformed.map(malformedPointResult)]
    if (points.length === 0) {
      return failedReport(
        options,
        started,
        issue('NO_RECOVERY_POINTS', 'integrity', 'Repository has no published recovery points'),
      )
    }
    const coverage = aggregateCoverage(points)
    const result = outcome(points)
    const ended = safeNow(options.now)
    const issues = points.flatMap((point) => point.issues)
    const resolvedPointIds = selected.map((point) => point.id)
    return {
      operation: 'verify',
      scope: options.scope,
      verificationScope: options.scope,
      selector: options.selector,
      resolvedPointIds,
      resolvedPointId: resolvedPointIds.length === 1 ? resolvedPointIds[0] : null,
      repositoryId: repository.descriptor.repositoryId,
      protection: repository.descriptor.protection,
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      durationMs: Math.max(0, ended.getTime() - started.getTime()),
      cost: options.scope === 'content' ? 'high' : 'low',
      ...result,
      ...coverage,
      coverage,
      points,
      issues,
      nextAction: issues[0]?.nextAction ?? null,
    }
  } catch (error) {
    return failedReport(options, started, classify(error))
  } finally {
    repository?.close()
  }
}

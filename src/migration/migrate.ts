import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CapturePlan } from '../catalog/types.js'
import { createV1RecoveryPoint } from '../engine/v1-backup.js'
import type { ResolvedPluginManifest } from '../plugin/types.js'
import { ProtectionError } from '../protection/errors.js'
import { readVerifiedFile } from '../recovery/safe-io.js'
import {
  RepositoryError,
  acquireRepositoryLock,
  assertRepositoryLockOwnership,
  openRepository,
} from '../repository/index.js'
import type { RepositoryHandle, RepositoryLock } from '../repository/index.js'
import { readBoundedRegularFile } from '../repository/io.js'
import {
  MAX_PROTECTED_MANIFEST_BYTES,
  discoverVisiblePoints,
  parseRecoveryPointManifestV1,
  verifyV1Repository,
} from '../verify/index.js'
import { assertLegacySourceUnchanged, readLegacyRepository } from './legacy.js'
import {
  LEGACY_MAX_CAPTURE_BYTES,
  LEGACY_MAX_FILE_BYTES,
  LEGACY_MAX_SOURCES,
  LegacyMigrationError,
} from './types.js'
import type {
  LegacyIssue,
  LegacyMigrationOptions,
  LegacyMigrationPointPlan,
  LegacyMigrationPointResult,
  LegacyMigrationReport,
  LegacyMigrationSource,
  LegacyRecoveryPointDescriptor,
  MigrationTargetReport,
} from './types.js'

const MIGRATION_LIMITATIONS = [
  'Migration copies immutable regular-file content; it never modifies or deletes the 0.1.x source.',
  '0.1.x did not preserve complete original metadata, so migrated metadata describes the legacy copy.',
  'Application installation is outside migration; recovery reports missing applications separately.',
] as const
// Matches the authenticated discovery bound, so every representable residue set has a retry slot.
const MAX_RETRY_POINT_IDS = 10_000

export interface LegacyMigrationDependencies {
  createRecoveryPoint: typeof createV1RecoveryPoint
  verifyRepository: typeof verifyV1Repository
  openRepository: typeof openRepository
  acquireLock: typeof acquireRepositoryLock
  /** Test-only fault hook after the immutable staging tree has been verified. */
  beforeMaterializedCapture?: (root: string) => void | Promise<void>
}

const DEFAULT_DEPENDENCIES: LegacyMigrationDependencies = {
  createRecoveryPoint: createV1RecoveryPoint,
  verifyRepository: verifyV1Repository,
  openRepository,
  acquireLock: acquireRepositoryLock,
}

function contained(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function migrationIssue(error: unknown): LegacyIssue {
  if (error instanceof LegacyMigrationError) {
    return { code: error.code, category: error.category, message: error.message }
  }
  if (error instanceof RepositoryError || error instanceof ProtectionError) {
    return {
      code: error.code,
      category:
        error instanceof RepositoryError
          ? error.category
          : error.code === 'AUTHENTICATION_FAILED'
            ? 'authentication'
            : 'integrity',
      message: error.message,
    }
  }
  return {
    code: 'LEGACY_MIGRATION_FAILED',
    category: 'internal',
    message: 'Legacy migration did not complete safely',
  }
}

function targetPointId(point: LegacyRecoveryPointDescriptor): string {
  const timestamp = point.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 45)
  return `legacy_${timestamp}_${point.digest.slice(0, 24)}`
}

function sourceRoot(relativePath: string): string {
  const components = relativePath.split('/')
  if (components[0] === 'Users' && components.length >= 3) {
    return components.slice(0, 3).join('/')
  }
  if (components.length >= 2) return components.slice(0, 2).join('/')
  return components[0] ?? ''
}

function isBroadDeclaredPath(path: string): boolean {
  const broad = new Set(['/', '/Users', resolve(homedir())])
  if (broad.has(path)) return true
  const components = path.split('/').filter(Boolean)
  return components[0] === 'Users' && components.length < 3
}

function buildSources(point: LegacyRecoveryPointDescriptor): {
  sources: LegacyMigrationSource[]
  unsupported: LegacyIssue[]
} {
  const unsupported = [...point.unsupported]
  if (point.totalBytes > LEGACY_MAX_CAPTURE_BYTES) {
    unsupported.push({
      code: 'LEGACY_CAPTURE_BUDGET_EXCEEDED',
      category: 'unsupported',
      message: 'Legacy point exceeds the v1 256 MiB bounded capture budget',
    })
  }
  const files = point.entries.filter((entry) => entry.type === 'file')
  const ancestorDirectories = new Set<string>()
  for (const entry of point.entries) {
    const components = entry.relativePath.split('/')
    for (let index = 1; index < components.length; index++) {
      ancestorDirectories.add(components.slice(0, index).join('/'))
    }
  }
  const leaves = point.entries.filter(
    (entry) => entry.type === 'file' || !ancestorDirectories.has(entry.relativePath),
  )
  const roots = [...new Set(leaves.map((entry) => sourceRoot(entry.relativePath)))].sort()
  if (roots.length === 0) {
    unsupported.push({
      code: 'LEGACY_EMPTY_POINT_UNSUPPORTED',
      category: 'unsupported',
      message: 'An entirely empty legacy point has no exact recoverable source mapping',
    })
  }
  if (roots.some((root) => !root)) {
    unsupported.push({
      code: 'LEGACY_MALFORMED_PATH',
      category: 'unsupported',
      message: 'Legacy point contains a malformed original path',
    })
  }
  if (roots.length > LEGACY_MAX_SOURCES) {
    unsupported.push({
      code: 'LEGACY_SOURCE_LIMIT_EXCEEDED',
      category: 'unsupported',
      message: 'Legacy point requires more than 256 exact v1 recovery sources',
    })
  }
  const sources = roots.slice(0, LEGACY_MAX_SOURCES).flatMap((root, index) => {
    const declaredPath = `/${root}`
    if (isBroadDeclaredPath(declaredPath)) {
      unsupported.push({
        code: 'LEGACY_SOURCE_TOO_BROAD',
        category: 'unsupported',
        message: 'Legacy path grouping would create a root, /Users, or full-home source',
        relativePath: root,
      })
      return []
    }
    const entry = point.entries.find((candidate) => candidate.relativePath === root)
    if (!entry) {
      unsupported.push({
        code: 'LEGACY_SOURCE_ROOT_MISSING',
        category: 'unsupported',
        message: 'Legacy path grouping could not resolve an exact source root',
        relativePath: root,
      })
      return []
    }
    const ownedFiles = files.filter(
      (candidate) =>
        candidate.relativePath === root || candidate.relativePath.startsWith(`${root}/`),
    )
    return [
      {
        id: `legacy_${point.digest.slice(0, 12)}_${String(index + 1).padStart(3, '0')}`,
        declaredPath,
        legacyPath: join(point.path, root),
        expectedType: entry.type,
        fileCount: ownedFiles.length,
        totalBytes: ownedFiles.reduce((total, candidate) => total + candidate.size, 0),
      } satisfies LegacyMigrationSource,
    ]
  })
  return { sources, unsupported }
}

export function buildLegacyMigrationPointPlan(
  point: LegacyRecoveryPointDescriptor,
): LegacyMigrationPointPlan {
  const built = buildSources(point)
  const entries = point.entries.flatMap((entry) => {
    const source = built.sources.find((candidate) => {
      const root = candidate.declaredPath.slice(1)
      return entry.relativePath === root || entry.relativePath.startsWith(`${root}/`)
    })
    if (!source) return []
    const root = source.declaredPath.slice(1)
    return [
      {
        sourceId: source.id,
        relativePath: entry.relativePath === root ? '.' : entry.relativePath.slice(root.length + 1),
        type: entry.type,
        size: entry.size,
        mode: entry.mode,
        modifiedAtNs: entry.modifiedAtNs,
        ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
      },
    ]
  })
  return {
    legacyPointId: point.id,
    legacyPointDigest: point.digest,
    targetPointId: targetPointId(point),
    createdAt: point.createdAt,
    fileCount: point.fileCount,
    totalBytes: point.totalBytes,
    sources: built.sources,
    entries,
    status: built.unsupported.length === 0 ? 'migratable' : 'unsupported',
    unsupported: built.unsupported,
  }
}

function capturePlan(
  point: LegacyMigrationPointPlan,
  materializedPaths: ReadonlyMap<string, string> = new Map(),
): CapturePlan {
  const pluginName = `legacy-migration-${point.legacyPointDigest}`
  const plugin: ResolvedPluginManifest = {
    name: pluginName,
    description: `Read-only migration of legacy point ${point.legacyPointId}`,
    paths: point.sources.map((source) => source.declaredPath),
    sources: point.sources.map((source) => ({
      name: source.id,
      path: source.declaredPath,
      requirement: 'required',
      sensitivity: 'private',
      expectedType: source.expectedType,
      recoveryScope: 'exact',
      includeEmptyDirectories: true,
    })),
  }
  return {
    plugins: [plugin],
    sources: point.sources.map((source) => ({
      id: `${pluginName}:${source.id}`,
      plugin: pluginName,
      name: source.id,
      declaredPath: source.declaredPath,
      path: materializedPaths.get(source.id) ?? source.legacyPath,
      requirement: 'required',
      sensitivity: 'private',
      expectedType: source.expectedType,
      recoveryScope: 'exact',
      includeEmptyDirectories: true,
    })),
  }
}

function capturedMetadataOverrides(point: LegacyMigrationPointPlan) {
  const pluginName = `legacy-migration-${point.legacyPointDigest}`
  return point.entries.map((entry) => ({
    sourceId: `${pluginName}:${entry.sourceId}`,
    relativePath: entry.relativePath,
    type: entry.type,
    metadata: {
      mode: entry.mode,
      size: entry.size,
      modifiedAtNs: entry.modifiedAtNs,
    },
  }))
}

async function materializeLegacyPoint(point: LegacyMigrationPointPlan): Promise<{
  root: string
  sourcePaths: Map<string, string>
  directories: string[]
}> {
  const temporary = await mkdtemp(join(tmpdir(), 'restore-legacy-migrate-'))
  const root = await realpath(temporary)
  const sourcePaths = new Map<string, string>()
  const directories = new Set([root])
  try {
    for (const [index, source] of point.sources.entries()) {
      const stagedPath = join(root, String(index + 1).padStart(3, '0'))
      sourcePaths.set(source.id, stagedPath)
      const entries = point.entries
        .filter((entry) => entry.sourceId === source.id)
        .sort((left, right) => {
          const depth = left.relativePath.split('/').length - right.relativePath.split('/').length
          return depth || compareText(left.relativePath, right.relativePath)
        })
      for (const entry of entries) {
        const destination =
          entry.relativePath === '.' ? stagedPath : join(stagedPath, entry.relativePath)
        if (entry.type === 'directory') {
          await mkdir(destination, { recursive: true, mode: 0o700 })
          directories.add(destination)
          continue
        }
        if (!entry.contentHash) {
          throw new LegacyMigrationError(
            'LEGACY_PROVENANCE_INCOMPLETE',
            'integrity',
            'Legacy file lacks the content hash required for safe materialization',
          )
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        let parent = dirname(destination)
        while (parent !== root && parent.startsWith(`${root}${sep}`)) {
          directories.add(parent)
          parent = dirname(parent)
        }
        const legacyPath =
          entry.relativePath === '.'
            ? source.legacyPath
            : join(source.legacyPath, entry.relativePath)
        const content = await readVerifiedFile(legacyPath, entry.size, entry.contentHash)
        try {
          await writeFile(destination, content, { flag: 'wx', mode: 0o600 })
        } finally {
          content.fill(0)
        }
      }
    }
    const files = point.entries.filter((entry) => entry.type === 'file')
    for (const entry of files) {
      const source = point.sources.find((candidate) => candidate.id === entry.sourceId)
      const stagedRoot = source ? sourcePaths.get(source.id) : undefined
      if (!source || !stagedRoot || !entry.contentHash) {
        throw new LegacyMigrationError(
          'LEGACY_STAGING_INVALID',
          'integrity',
          'Legacy staging tree could not be bound to its exact provenance',
        )
      }
      const path = entry.relativePath === '.' ? stagedRoot : join(stagedRoot, entry.relativePath)
      await chmod(path, 0o400)
    }
    const orderedDirectories = [...directories].sort(
      (left, right) => right.split(sep).length - left.split(sep).length,
    )
    for (const path of orderedDirectories) await chmod(path, 0o500)
    for (const path of orderedDirectories) {
      const metadata = await lstat(path, { bigint: true })
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o777n) !== 0o500n
      ) {
        throw new LegacyMigrationError(
          'LEGACY_STAGING_INVALID',
          'integrity',
          'Legacy staging directory did not become immutable',
        )
      }
    }
    for (const entry of files) {
      const source = point.sources.find((candidate) => candidate.id === entry.sourceId)
      const stagedRoot = source ? sourcePaths.get(source.id) : undefined
      if (!stagedRoot || !entry.contentHash) throw new Error('staging provenance missing')
      const path = entry.relativePath === '.' ? stagedRoot : join(stagedRoot, entry.relativePath)
      const content = await readVerifiedFile(path, entry.size, entry.contentHash)
      content.fill(0)
      const metadata = await lstat(path, { bigint: true })
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size !== BigInt(entry.size) ||
        (metadata.mode & 0o777n) !== 0o400n
      ) {
        throw new LegacyMigrationError(
          'LEGACY_STAGING_INVALID',
          'integrity',
          'Legacy staged file identity did not match immutable provenance',
        )
      }
    }
    return { root, sourcePaths, directories: orderedDirectories }
  } catch (error) {
    await thawAndRemoveMaterialized(root, [...directories]).catch(() => undefined)
    throw error
  }
}

async function thawAndRemoveMaterialized(
  root: string,
  directories: readonly string[],
): Promise<void> {
  await chmod(root, 0o700).catch(() => undefined)
  for (const path of [...directories].sort(
    (left, right) => left.split(sep).length - right.split(sep).length,
  )) {
    await chmod(path, 0o700).catch(() => undefined)
  }
  await rm(root, { recursive: true, force: false })
}

function requiredBytes(points: readonly LegacyMigrationPointPlan[]): bigint {
  return points.reduce(
    (total, point) =>
      total +
      BigInt(point.totalBytes) +
      BigInt(point.fileCount) * 2048n +
      BigInt(point.entries.length) * 16n * 1024n +
      BigInt(point.sources.length) * 16n * 1024n +
      1024n * 1024n,
    0n,
  )
}

function initialTarget(options: LegacyMigrationOptions, required: bigint): MigrationTargetReport {
  return {
    repositoryPath: resolve(options.repositoryPath),
    repositoryId: options.expectedRepositoryId,
    protection: options.expectedProtection,
    requiredBytes: required.toString(),
    availableBytes: null,
    authenticated: false,
    capabilityChecked: false,
    lockChecked: false,
  }
}

async function preflightTarget(
  options: LegacyMigrationOptions,
  required: bigint,
  dryRun: boolean,
  dependencies: LegacyMigrationDependencies,
): Promise<MigrationTargetReport> {
  const repository = await dependencies.openRepository(options.repositoryPath, {
    intent: dryRun ? 'read' : 'write',
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
    requiredBytes: required,
  })
  try {
    if (options.expectedProtection === 'encrypted' && !repository.protector) {
      throw new LegacyMigrationError(
        'REPOSITORY_AUTHENTICATION_FAILED',
        'authentication',
        'Encrypted migration target must be authenticated during preflight',
      )
    }
    return {
      repositoryPath: repository.path,
      repositoryId: repository.descriptor.repositoryId,
      protection: repository.descriptor.protection,
      requiredBytes: required.toString(),
      availableBytes: repository.preflight.availableBytes.toString(),
      authenticated:
        repository.descriptor.protection === 'plaintext' || Boolean(repository.protector),
      capabilityChecked: repository.preflight.capabilities.writeChecked,
      lockChecked: false,
    }
  } finally {
    repository.close()
  }
}

function lockedTargetReport(repository: RepositoryHandle, required: bigint): MigrationTargetReport {
  if (repository.preflight.availableBytes < required) {
    throw new LegacyMigrationError(
      'TARGET_SPACE_INSUFFICIENT',
      'destination',
      'Target does not have enough available space for the remaining migration',
    )
  }
  return {
    repositoryPath: repository.path,
    repositoryId: repository.descriptor.repositoryId,
    protection: repository.descriptor.protection,
    requiredBytes: required.toString(),
    availableBytes: repository.preflight.availableBytes.toString(),
    authenticated:
      repository.descriptor.protection === 'plaintext' || Boolean(repository.protector),
    capabilityChecked: repository.preflight.capabilities.writeChecked,
    lockChecked: true,
  }
}

async function pathKind(path: string): Promise<'missing' | 'directory' | 'unsafe'> {
  try {
    const metadata = await lstat(path)
    return metadata.isDirectory() && !metadata.isSymbolicLink() ? 'directory' : 'unsafe'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    return 'unsafe'
  }
}

async function verifyPoint(
  options: LegacyMigrationOptions,
  pointId: string,
  dependencies: LegacyMigrationDependencies,
  expectedPoint?: LegacyMigrationPointPlan,
): Promise<'missing' | 'healthy'> {
  const report = await dependencies.verifyRepository({
    repositoryPath: options.repositoryPath,
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
    selector: { kind: 'point', pointId },
    scope: 'content',
  })
  if (report.state === 'success' && report.resolvedPointId === pointId) {
    if (expectedPoint) await assertPointProvenance(options, pointId, expectedPoint, dependencies)
    return 'healthy'
  }
  if (report.issues.some((entry) => entry.code === 'POINT_NOT_FOUND')) return 'missing'
  throw new LegacyMigrationError(
    report.issues[0]?.code ?? 'MIGRATED_POINT_UNHEALTHY',
    report.issues[0]?.category ?? 'integrity',
    'Existing or newly migrated recovery point did not pass complete content verification',
  )
}

async function assertPointProvenance(
  options: LegacyMigrationOptions,
  pointId: string,
  expectedPoint: LegacyMigrationPointPlan,
  dependencies: LegacyMigrationDependencies,
): Promise<void> {
  const repository = await dependencies.openRepository(options.repositoryPath, {
    intent: 'read',
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
  })
  try {
    if (!repository.protector) {
      throw new LegacyMigrationError(
        'REPOSITORY_AUTHENTICATION_FAILED',
        'authentication',
        'Migration provenance cannot be authenticated from the target repository',
      )
    }
    const discovery = await discoverVisiblePoints(repository)
    const point = discovery.points.find((candidate) => candidate.id === pointId)
    if (!point) {
      throw new LegacyMigrationError(
        'MIGRATED_POINT_NOT_FOUND',
        'integrity',
        'Verified migration point disappeared before provenance inspection',
      )
    }
    const protectedManifest = await readBoundedRegularFile(
      join(point.path, point.descriptor.manifest),
      MAX_PROTECTED_MANIFEST_BYTES,
    )
    let plaintext: Buffer | undefined
    try {
      plaintext = await repository.protector.open(protectedManifest, {
        repositoryId: repository.descriptor.repositoryId,
        purpose: 'manifest',
        objectId: pointId,
      })
      const manifest = parseRecoveryPointManifestV1(JSON.parse(plaintext.toString('utf8')))
      const expected = capturePlan(expectedPoint)
      const expectedPlugin = expected.plugins[0]?.name
      const expectedSources = new Map(
        expected.sources.map((source) => [
          source.id,
          {
            plugin: source.plugin,
            name: source.name,
            declaredPath: source.declaredPath,
            requirement: source.requirement,
            sensitivity: source.sensitivity,
            expectedType: source.expectedType,
            recoveryScope: source.recoveryScope,
            includeEmptyDirectories: source.includeEmptyDirectories,
          },
        ]),
      )
      const expectedEntries = new Map(
        expectedPoint.entries.map((entry) => [
          `${expectedPlugin}:${entry.sourceId}:${entry.relativePath}`,
          entry,
        ]),
      )
      const provenanceMatches =
        expectedPlugin !== undefined &&
        manifest.plugins.length === 1 &&
        manifest.plugins[0] === expectedPlugin &&
        manifest.startedAt === expectedPoint.createdAt &&
        manifest.completedAt === expectedPoint.createdAt &&
        manifest.sources.length === expectedSources.size &&
        manifest.entries.length === expectedEntries.size &&
        manifest.sources.every((source) => {
          const expectedSource = expectedSources.get(source.id)
          return (
            expectedSource !== undefined &&
            source.plugin === expectedSource.plugin &&
            source.name === expectedSource.name &&
            source.declaredPath === expectedSource.declaredPath &&
            source.requirement === expectedSource.requirement &&
            source.sensitivity === expectedSource.sensitivity &&
            source.expectedType === expectedSource.expectedType &&
            source.recoveryScope === expectedSource.recoveryScope &&
            source.includeEmptyDirectories === expectedSource.includeEmptyDirectories &&
            source.status === 'captured'
          )
        }) &&
        manifest.entries.every((entry) => {
          const expectedEntry = expectedEntries.get(`${entry.sourceId}:${entry.relativePath}`)
          return (
            expectedEntry !== undefined &&
            entry.type === expectedEntry.type &&
            entry.metadata.mode === expectedEntry.mode &&
            entry.metadata.modifiedAtNs === expectedEntry.modifiedAtNs &&
            (entry.type !== 'file' ||
              (entry.metadata.size === expectedEntry.size &&
                entry.contentHash === expectedEntry.contentHash))
          )
        })
      if (!provenanceMatches) {
        throw new LegacyMigrationError(
          'MIGRATION_PROVENANCE_MISMATCH',
          'integrity',
          'Existing recovery point does not match deterministic legacy migration provenance',
        )
      }
    } catch (error) {
      if (error instanceof LegacyMigrationError) throw error
      throw new LegacyMigrationError(
        'MIGRATION_PROVENANCE_INVALID',
        'integrity',
        'Existing recovery point provenance could not be validated',
      )
    } finally {
      protectedManifest.fill(0)
      plaintext?.fill(0)
    }
  } finally {
    repository.close()
  }
}

async function resolveAttemptPointId(
  options: LegacyMigrationOptions,
  point: LegacyMigrationPointPlan,
  dependencies: LegacyMigrationDependencies,
): Promise<{ pointId: string; existing: boolean }> {
  const repository = await dependencies.openRepository(options.repositoryPath, {
    intent: 'read',
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
  })
  let pointsHandle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const heldPoints = await open(
      repository.layout.points,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    )
    pointsHandle = heldPoints
    if (repository.descriptor.protection === 'encrypted' && !repository.protector) {
      throw new LegacyMigrationError(
        'REPOSITORY_AUTHENTICATION_FAILED',
        'authentication',
        'Migration retry discovery requires an authenticated repository',
      )
    }
    const held = await heldPoints.stat({ bigint: true })
    const assertPointsStable = async (): Promise<void> => {
      const opened = await heldPoints.stat({ bigint: true })
      const named = await lstat(repository.layout.points, { bigint: true })
      if (
        !opened.isDirectory() ||
        !named.isDirectory() ||
        opened.dev !== held.dev ||
        opened.ino !== held.ino ||
        named.dev !== held.dev ||
        named.ino !== held.ino
      ) {
        throw new LegacyMigrationError(
          'MIGRATION_POINTS_DIRECTORY_CHANGED',
          'integrity',
          'Authenticated migration points directory identity changed during retry discovery',
        )
      }
    }
    await assertPointsStable()
    const discovery = await discoverVisiblePoints(repository)
    await assertPointsStable()
    for (let attempt = 0; attempt < MAX_RETRY_POINT_IDS; attempt++) {
      const pointId = attempt === 0 ? point.targetPointId : `${point.targetPointId}-r${attempt}`
      if (
        discovery.diagnostics.some(
          (diagnostic) => diagnostic.pointId === pointId || diagnostic.name === pointId,
        )
      ) {
        throw new LegacyMigrationError(
          'MIGRATION_POINT_PATH_UNSAFE',
          'integrity',
          'Migration target point path is malformed or unsafe',
        )
      }
      if (discovery.points.some((candidate) => candidate.id === pointId)) {
        if ((await verifyPoint(options, pointId, dependencies, point)) !== 'healthy') {
          throw new LegacyMigrationError(
            'MIGRATED_POINT_DISAPPEARED',
            'integrity',
            'Discovered migration point disappeared before authenticated verification',
          )
        }
        await assertPointsStable()
        return { pointId, existing: true }
      }
      await assertPointsStable()
      const pendingKind = await pathKind(join(repository.layout.points, `${pointId}.pending`))
      await assertPointsStable()
      if (pendingKind === 'unsafe') {
        throw new LegacyMigrationError(
          'MIGRATION_PENDING_PATH_UNSAFE',
          'integrity',
          'Interrupted migration pending state is not a safe invisible directory',
        )
      }
      if (pendingKind === 'missing') return { pointId, existing: false }
    }
  } finally {
    await pointsHandle?.close().catch(() => undefined)
    repository.close()
  }
  throw new LegacyMigrationError(
    'MIGRATION_RETRY_LIMIT_EXCEEDED',
    'destination',
    'Too many interrupted pending attempts exist for this legacy point',
  )
}

function metadataRunner(executable: string): Promise<Buffer> {
  return Promise.resolve(executable.endsWith('/stat') ? Buffer.from('-\n') : Buffer.alloc(0))
}

function outcome(
  dryRun: boolean,
  results: readonly LegacyMigrationPointResult[],
  globalUnsupported: readonly LegacyIssue[],
  finalVerified: boolean,
): Pick<LegacyMigrationReport, 'state' | 'category'> {
  const failure = results.find((result) => result.state === 'failure')
  if (failure) return { state: 'failure', category: failure.issues[0]?.category ?? 'internal' }
  const unsupported = results.some((result) => result.state === 'unsupported')
  if (unsupported || globalUnsupported.length > 0) {
    return { state: 'partial', category: 'unsupported' }
  }
  if (!dryRun && !finalVerified) return { state: 'failure', category: 'integrity' }
  return { state: 'success', category: 'success' }
}

function pointByLegacyId(
  points: readonly LegacyMigrationPointPlan[],
  legacyPointId: string,
): LegacyMigrationPointPlan {
  const point = points.find((candidate) => candidate.legacyPointId === legacyPointId)
  if (!point) {
    throw new LegacyMigrationError(
      'MIGRATION_PROVENANCE_MISSING',
      'integrity',
      'Migrated target has no matching legacy provenance plan',
    )
  }
  return point
}

export async function migrateLegacyRepository(
  options: LegacyMigrationOptions,
  overrides: Partial<LegacyMigrationDependencies> = {},
): Promise<LegacyMigrationReport> {
  const startedAt = new Date().toISOString()
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const dryRun = options.dryRun !== false
  let source = await readLegacyRepository(options.legacyRepositoryPath, {
    ...(options.system ? { system: options.system } : {}),
  })
  const requested = options.pointIds ? [...new Set(options.pointIds)] : undefined
  const selected = requested
    ? requested.map((id) => source.points.find((point) => point.id === id)).filter(Boolean)
    : source.points
  if (requested && selected.length !== requested.length) {
    throw new LegacyMigrationError(
      'LEGACY_POINT_NOT_FOUND',
      'integrity',
      'One or more selected legacy recovery points do not exist',
    )
  }
  if (selected.length === 0) {
    throw new LegacyMigrationError(
      'NO_LEGACY_RECOVERY_POINTS',
      'integrity',
      'Legacy repository has no complete recovery points to migrate',
    )
  }
  const points = (selected as LegacyRecoveryPointDescriptor[])
    .map(buildLegacyMigrationPointPlan)
    .sort((left, right) => compareText(left.createdAt, right.createdAt))
  const required = requiredBytes(points.filter((point) => point.status === 'migratable'))
  let target = initialTarget(options, required)
  const results: LegacyMigrationPointResult[] = []
  const attempts = new Map<string, { pointId: string; existing: boolean }>()
  let finalRepositoryVerified = false
  let transactionRepository: RepositoryHandle | undefined
  let transactionLock: RepositoryLock | undefined

  try {
    let targetRoot: string
    try {
      targetRoot = await realpath(options.repositoryPath)
    } catch (error) {
      throw new LegacyMigrationError(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'REPOSITORY_MISSING'
          : 'TARGET_INSPECTION_FAILED',
        'destination',
        'Migration target repository could not be resolved safely',
      )
    }
    if (contained(source.rootPath, targetRoot) || contained(targetRoot, source.rootPath)) {
      throw new LegacyMigrationError(
        'MIGRATION_TARGET_OVERLAPS_SOURCE',
        'destination',
        'Migration target cannot contain or be contained by the read-only legacy source',
      )
    }
    if (!dryRun) {
      transactionRepository = await dependencies.openRepository(options.repositoryPath, {
        intent: 'write',
        expectedRepositoryId: options.expectedRepositoryId,
        expectedProtection: options.expectedProtection,
        ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
        requiredBytes: 0n,
      })
      transactionLock = await dependencies.acquireLock(transactionRepository, 'legacy-migration')
      await assertRepositoryLockOwnership(transactionRepository, transactionLock)
    }
    for (const point of points.filter((candidate) => candidate.status === 'migratable')) {
      attempts.set(point.legacyPointId, await resolveAttemptPointId(options, point, dependencies))
    }
    const remainingRequired = requiredBytes(
      points.filter(
        (point) => point.status === 'migratable' && !attempts.get(point.legacyPointId)?.existing,
      ),
    )
    if (dryRun) target = await preflightTarget(options, remainingRequired, true, dependencies)
    else {
      if (!transactionRepository || !transactionLock) {
        throw new LegacyMigrationError(
          'MIGRATION_LOCK_REQUIRED',
          'lock',
          'Migration-wide repository lock was not established',
        )
      }
      await assertRepositoryLockOwnership(transactionRepository, transactionLock)
      target = lockedTargetReport(transactionRepository, remainingRequired)
    }
    let after = await readLegacyRepository(options.legacyRepositoryPath, {
      ...(options.system ? { system: options.system } : {}),
    })
    assertLegacySourceUnchanged(source, after)
    source = after

    for (const point of points) {
      if (point.status === 'unsupported') {
        results.push({
          legacyPointId: point.legacyPointId,
          targetPointId: point.targetPointId,
          state: 'unsupported',
          contentVerified: false,
          issues: point.unsupported,
        })
        continue
      }
      try {
        const beforePointOperation = source
        const attempt = attempts.get(point.legacyPointId)
        if (!attempt) {
          throw new LegacyMigrationError(
            'MIGRATION_ATTEMPT_NOT_PLANNED',
            'internal',
            'Migration attempt was omitted from authenticated retry discovery',
          )
        }
        if (attempt.existing) {
          if ((await verifyPoint(options, attempt.pointId, dependencies, point)) !== 'healthy') {
            throw new LegacyMigrationError(
              'MIGRATED_POINT_DISAPPEARED',
              'integrity',
              'Existing migration point disappeared before reuse',
            )
          }
          results.push({
            legacyPointId: point.legacyPointId,
            targetPointId: attempt.pointId,
            state: 'already-imported',
            contentVerified: true,
            issues: [],
          })
        } else {
          const materialized = await materializeLegacyPoint(point)
          let created: Awaited<ReturnType<typeof createV1RecoveryPoint>>
          try {
            if (!dryRun) {
              if (!transactionRepository || !transactionLock) {
                throw new LegacyMigrationError(
                  'MIGRATION_LOCK_REQUIRED',
                  'lock',
                  'Migration-wide repository lock was lost before import',
                )
              }
              await assertRepositoryLockOwnership(transactionRepository, transactionLock)
            }
            await dependencies.beforeMaterializedCapture?.(materialized.root)
            after = await readLegacyRepository(options.legacyRepositoryPath, {
              ...(options.system ? { system: options.system } : {}),
            })
            assertLegacySourceUnchanged(beforePointOperation, after)
            created = await dependencies.createRecoveryPoint({
              repositoryPath: options.repositoryPath,
              expectedRepositoryId: options.expectedRepositoryId,
              expectedProtection: options.expectedProtection,
              ...(options.credentialProvider
                ? { credentialProvider: options.credentialProvider }
                : {}),
              plan: capturePlan(point, materialized.sourcePaths),
              capturedMetadataOverrides: capturedMetadataOverrides(point),
              pointId: attempt.pointId,
              dryRun,
              cliVersion: options.cliVersion ?? '1.0.0',
              now: () => new Date(point.createdAt),
              capture: {
                maxFileBytes: LEGACY_MAX_FILE_BYTES,
                maxTotalBytes: LEGACY_MAX_CAPTURE_BYTES,
                metadataCommandRunner: metadataRunner,
              },
              ...(!dryRun && transactionLock ? { heldLock: transactionLock } : {}),
            })
          } finally {
            await thawAndRemoveMaterialized(materialized.root, materialized.directories)
          }
          if (!['success', 'warning'].includes(created.state)) {
            throw new LegacyMigrationError(
              created.issues[0]?.code ?? 'MIGRATION_POINT_CREATE_FAILED',
              created.issues[0]?.category ?? 'destination',
              created.issues[0]?.message ??
                'Public v1 recovery-point writer did not complete the import',
            )
          }
          if (
            !dryRun &&
            (await verifyPoint(options, attempt.pointId, dependencies, point)) !== 'healthy'
          ) {
            throw new LegacyMigrationError(
              'MIGRATED_POINT_DISAPPEARED',
              'integrity',
              'New migration point disappeared before content verification',
            )
          }
          if (!dryRun && transactionRepository && transactionLock) {
            await assertRepositoryLockOwnership(transactionRepository, transactionLock)
          }
          results.push({
            legacyPointId: point.legacyPointId,
            targetPointId: attempt.pointId,
            state: dryRun ? 'planned' : 'imported',
            contentVerified: !dryRun,
            issues: [],
          })
        }
        after = await readLegacyRepository(options.legacyRepositoryPath, {
          ...(options.system ? { system: options.system } : {}),
        })
        assertLegacySourceUnchanged(beforePointOperation, after)
        source = after
      } catch (error) {
        results.push({
          legacyPointId: point.legacyPointId,
          targetPointId: point.targetPointId,
          state: 'failure',
          contentVerified: false,
          issues: [migrationIssue(error)],
        })
        break
      }
    }

    if (!dryRun && !results.some((result) => result.state === 'failure')) {
      if (!transactionRepository || !transactionLock) {
        throw new LegacyMigrationError(
          'MIGRATION_LOCK_REQUIRED',
          'lock',
          'Migration-wide repository lock was lost before final verification',
        )
      }
      await assertRepositoryLockOwnership(transactionRepository, transactionLock)
      for (const migrated of results.filter(
        (entry) => entry.state === 'imported' || entry.state === 'already-imported',
      )) {
        const expectedPoint = pointByLegacyId(points, migrated.legacyPointId)
        if (
          (await verifyPoint(options, migrated.targetPointId, dependencies, expectedPoint)) !==
          'healthy'
        ) {
          throw new LegacyMigrationError(
            'MIGRATED_POINT_DISAPPEARED',
            'integrity',
            'Expected migrated point is absent from the final verified target set',
          )
        }
      }
      const final = await dependencies.verifyRepository({
        repositoryPath: options.repositoryPath,
        expectedRepositoryId: options.expectedRepositoryId,
        expectedProtection: options.expectedProtection,
        ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
        selector: { kind: 'all' },
        scope: 'content',
      })
      finalRepositoryVerified = final.state === 'success' && final.coverage.complete
      await assertRepositoryLockOwnership(transactionRepository, transactionLock)
      if (!finalRepositoryVerified) {
        results.push({
          legacyPointId: 'repository-final-verification',
          targetPointId: 'all',
          state: 'failure',
          contentVerified: false,
          issues: [
            {
              code: final.issues[0]?.code ?? 'FINAL_REPOSITORY_VERIFICATION_FAILED',
              category: final.issues[0]?.category ?? 'integrity',
              message: 'Final migration target repository verification did not pass',
            },
          ],
        })
      }
      after = await readLegacyRepository(options.legacyRepositoryPath, {
        ...(options.system ? { system: options.system } : {}),
      })
      assertLegacySourceUnchanged(source, after)
      source = after
    }
  } catch (error) {
    results.push({
      legacyPointId: 'preflight',
      targetPointId: 'none',
      state: 'failure',
      contentVerified: false,
      issues: [migrationIssue(error)],
    })
  } finally {
    if (transactionLock) {
      try {
        await transactionLock.release()
      } catch (error) {
        results.push({
          legacyPointId: 'migration-lock-release',
          targetPointId: 'none',
          state: 'failure',
          contentVerified: false,
          issues: [migrationIssue(error)],
        })
      }
    }
    transactionRepository?.close()
  }

  const result = outcome(dryRun, results, source.unsupported, finalRepositoryVerified)
  const pointById = new Map(points.map((point) => [point.legacyPointId, point]))
  const filesFor = (states: LegacyMigrationPointResult['state'][]): number =>
    results
      .filter((entry) => states.includes(entry.state))
      .reduce((total, entry) => total + (pointById.get(entry.legacyPointId)?.fileCount ?? 0), 0)
  const bytesFor = (states: LegacyMigrationPointResult['state'][]): number =>
    results
      .filter((entry) => states.includes(entry.state))
      .reduce((total, entry) => total + (pointById.get(entry.legacyPointId)?.totalBytes ?? 0), 0)
  return {
    operation: 'legacy-migrate',
    startedAt,
    endedAt: new Date().toISOString(),
    dryRun,
    ...result,
    counts: {
      filesConsidered: points.reduce((total, point) => total + point.fileCount, 0),
      filesWritten: filesFor(['imported']),
      filesSkipped: filesFor(['already-imported', 'unsupported']),
      filesFailed: filesFor(['failure']),
      bytesRead: bytesFor(['planned', 'imported']),
      bytesWritten: bytesFor(['imported']),
    },
    verificationScope: !dryRun && finalRepositoryVerified ? 'content' : 'structural',
    source: {
      repositoryPath: source.rootPath,
      repositoryDigest: source.digest,
      readOnly: true,
      deleted: false,
    },
    target,
    points,
    results,
    unsupported: [...source.unsupported, ...points.flatMap((point) => point.unsupported)],
    finalRepositoryVerified,
    limitations: [...MIGRATION_LIMITATIONS],
  }
}

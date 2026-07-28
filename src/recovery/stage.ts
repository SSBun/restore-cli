import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { ProtectionAuthenticationError, ProtectionError } from '../protection/errors.js'
import { RepositoryError, openRepository } from '../repository/index.js'
import type { ClassifiedIssue, RepositoryHandle } from '../repository/index.js'
import { readBoundedRegularFile } from '../repository/io.js'
import { expandPath } from '../util/path.js'
import {
  MAX_PROTECTED_BLOB_BYTES,
  MAX_PROTECTED_MANIFEST_BYTES,
  POINT_ID_PATTERN,
  assertDescriptorManifestAgreement,
  discoverVisiblePoints,
  parseRecoveryPointManifestV1,
  verifyV1Repository,
} from '../verify/index.js'
import type {
  DiscoveredPoint,
  ManifestEntryV1,
  ManifestSourceV1,
  RecoveryPointManifestV1,
} from '../verify/index.js'
import { restoreMetadata, verifyMetadata } from './metadata.js'
import {
  assertDirectoryIdentity,
  assertSafeAbsoluteDirectoryChain,
  assertSafeDirectory,
  atomicPublish,
  atomicRenameDirectory,
  fingerprintFile,
  lstatIdentity,
  mkdirUnderRoot,
  pathUnder,
  pathsOverlap,
  readDirectoryBoundFile,
  readLinkSafely,
  readVerifiedFile,
  safeRelativePath,
} from './safe-io.js'
import type {
  RecoveryCounts,
  RecoveryRepositoryOptions,
  RecoveryResult,
  RecoverySelection,
  RecoverySourceSummary,
  ResolvePointOptions,
  StageRecoveryOptions,
  StagedEntry,
  StagingDescriptor,
} from './types.js'

const STAGING_DESCRIPTOR = '.restore-stage.json'
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

export class RecoveryFailure extends Error {
  constructor(
    readonly category: ClassifiedIssue['category'],
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function issue(
  code: string,
  category: ClassifiedIssue['category'],
  message: string,
  nextAction?: string,
): ClassifiedIssue {
  return { code, category, message, ...(nextAction ? { nextAction } : {}) }
}

function classify(error: unknown): ClassifiedIssue {
  if (error instanceof RecoveryFailure) return issue(error.code, error.category, error.message)
  if (error instanceof ProtectionAuthenticationError) {
    return issue(
      'AUTHENTICATION_FAILED',
      'authentication',
      'Repository credentials could not authenticate recovery data',
    )
  }
  if (error instanceof ProtectionError) {
    return issue(error.code, 'integrity', 'Protected recovery data is invalid')
  }
  if (error instanceof RepositoryError) return issue(error.code, error.category, error.message)
  return issue('RECOVERY_FAILED', 'integrity', 'Recovery could not be completed safely')
}

function safeNow(now?: () => Date): Date {
  const value = now?.() ?? new Date()
  if (!Number.isFinite(value.getTime())) throw new Error('invalid clock')
  return value
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableSelection(selection: RecoverySelection): RecoverySelection {
  if (selection.kind === 'all') return selection
  if (selection.kind === 'plugin') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(selection.plugin)) {
      throw new RecoveryFailure(
        'configuration',
        'INVALID_RECOVERY_SELECTION',
        'Plugin selector is invalid',
      )
    }
    return selection
  }
  if (selection.kind === 'sources') {
    const sourceIds = [...new Set(selection.sourceIds)].sort()
    if (sourceIds.length === 0 || sourceIds.some((id) => id.length > 201 || id.includes('\0'))) {
      throw new RecoveryFailure(
        'configuration',
        'INVALID_RECOVERY_SELECTION',
        'Source selector is invalid',
      )
    }
    return { kind: 'sources', sourceIds }
  }
  const paths = selection.paths
    .map((path) => ({ sourceId: path.sourceId, relativePath: safeRelativePath(path.relativePath) }))
    .sort(
      (left, right) =>
        left.sourceId.localeCompare(right.sourceId) ||
        left.relativePath.localeCompare(right.relativePath),
    )
  if (
    paths.length === 0 ||
    new Set(paths.map((path) => `${path.sourceId}\0${path.relativePath}`)).size !== paths.length
  ) {
    throw new RecoveryFailure(
      'configuration',
      'INVALID_RECOVERY_SELECTION',
      'Path selector is invalid',
    )
  }
  return { kind: 'paths', paths }
}

function entrySelected(entry: ManifestEntryV1, selection: RecoverySelection): boolean {
  if (selection.kind === 'all') return true
  if (selection.kind === 'sources') return selection.sourceIds.includes(entry.sourceId)
  if (selection.kind === 'plugin') return false
  return selection.paths.some(
    (path) =>
      path.sourceId === entry.sourceId &&
      (entry.relativePath === path.relativePath ||
        entry.relativePath.startsWith(`${path.relativePath}/`)),
  )
}

function selectEntries(
  manifest: RecoveryPointManifestV1,
  selection: RecoverySelection,
): { sources: ManifestSourceV1[]; entries: ManifestEntryV1[]; selectedIds: Set<string> } {
  let sourceIds: Set<string>
  if (selection.kind === 'all') sourceIds = new Set(manifest.sources.map((source) => source.id))
  else if (selection.kind === 'plugin') {
    sourceIds = new Set(
      manifest.sources
        .filter((source) => source.plugin === selection.plugin)
        .map((source) => source.id),
    )
  } else if (selection.kind === 'sources') sourceIds = new Set(selection.sourceIds)
  else sourceIds = new Set(selection.paths.map((path) => path.sourceId))
  if (
    sourceIds.size === 0 ||
    [...sourceIds].some((id) => !manifest.sources.some((s) => s.id === id))
  ) {
    throw new RecoveryFailure(
      'configuration',
      'RECOVERY_SELECTION_NOT_DECLARED',
      'Recovery selection is outside the selected point manifest',
    )
  }

  const selectedIds = new Set<string>()
  for (const entry of manifest.entries) {
    if (
      sourceIds.has(entry.sourceId) &&
      (selection.kind !== 'paths' || entrySelected(entry, selection))
    ) {
      selectedIds.add(entry.id)
    }
  }
  if (selection.kind === 'paths') {
    for (const requested of selection.paths) {
      if (
        !manifest.entries.some(
          (entry) =>
            entry.sourceId === requested.sourceId && entry.relativePath === requested.relativePath,
        )
      ) {
        throw new RecoveryFailure(
          'configuration',
          'RECOVERY_PATH_NOT_DECLARED',
          'A selected path is not declared by the recovery point',
        )
      }
    }
    for (const entry of manifest.entries) {
      if (
        entry.type === 'directory' &&
        [...selectedIds].some((id) => {
          const child = manifest.entries.find((candidate) => candidate.id === id)
          return (
            child?.sourceId === entry.sourceId &&
            (entry.relativePath === '.' || child.relativePath.startsWith(`${entry.relativePath}/`))
          )
        })
      ) {
        selectedIds.add(entry.id)
      }
    }
  }
  const requestedIds = new Set(selectedIds)
  for (const entry of manifest.entries) {
    if (requestedIds.has(entry.id) && entry.hardlinkTo) selectedIds.add(entry.hardlinkTo)
  }
  const entries = manifest.entries.filter((entry) => selectedIds.has(entry.id))
  if (entries.length === 0) {
    throw new RecoveryFailure(
      'configuration',
      'EMPTY_RECOVERY_SELECTION',
      'Recovery selection is empty',
    )
  }
  const sources = manifest.sources.filter((source) => sourceIds.has(source.id))
  return { sources, entries, selectedIds: requestedIds }
}

function stageRelative(sourceId: string, relativePath: string): string {
  const sourceDirectory = hash(sourceId).slice(0, 24)
  return relativePath === '.'
    ? `payload/${sourceDirectory}`
    : `payload/${sourceDirectory}/${safeRelativePath(relativePath)}`
}

async function loadManifest(
  repository: RepositoryHandle,
  point: DiscoveredPoint,
): Promise<{ manifest: RecoveryPointManifestV1; fingerprint: string }> {
  const before = await lstat(point.path, { bigint: true })
  if (!before.isDirectory() || before.dev !== point.device || before.ino !== point.inode) {
    throw new RecoveryFailure(
      'integrity',
      'POINT_IDENTITY_CHANGED',
      'Recovery point identity changed',
    )
  }
  const protectedManifest = await readDirectoryBoundFile(
    point.path,
    point.descriptor.manifest,
    MAX_PROTECTED_MANIFEST_BYTES,
  )
  let plaintext: Buffer | undefined
  try {
    if (!repository.protector) throw new ProtectionAuthenticationError()
    plaintext = await repository.protector.open(protectedManifest, {
      repositoryId: repository.descriptor.repositoryId,
      purpose: 'manifest',
      objectId: point.id,
    })
    if (plaintext.length > MAX_PROTECTED_MANIFEST_BYTES) throw new Error('manifest too large')
    const manifest = parseRecoveryPointManifestV1(JSON.parse(plaintext.toString('utf8')))
    assertDescriptorManifestAgreement(
      point.descriptor,
      manifest,
      basename(point.path),
      repository.descriptor.repositoryId,
      repository.descriptor.protection,
    )
    const after = await lstat(point.path, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino) throw new Error('point changed')
    return { manifest, fingerprint: hash(plaintext) }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new RecoveryFailure(
        'integrity',
        'INVALID_POINT_MANIFEST',
        'Recovery point manifest is invalid',
      )
    }
    throw error
  } finally {
    protectedManifest.fill(0)
    plaintext?.fill(0)
  }
}

export async function resolvePoint(options: ResolvePointOptions): Promise<{
  repository: RepositoryHandle
  point: DiscoveredPoint
  manifest: RecoveryPointManifestV1
  manifestFingerprint: string
}> {
  if (options.pointId && !POINT_ID_PATTERN.test(options.pointId)) {
    throw new RecoveryFailure('configuration', 'INVALID_POINT_ID', 'Recovery point ID is invalid')
  }
  const selector = options.pointId
    ? ({ kind: 'point', pointId: options.pointId } as const)
    : ({ kind: 'latest-healthy' } as const)
  const verification = await verifyV1Repository({
    repositoryPath: options.repositoryPath,
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
    selector,
    scope: 'structural',
  })
  if (verification.state === 'failure' || !verification.resolvedPointId) {
    const first = verification.issues[0]
    throw new RecoveryFailure(
      first?.category ?? 'integrity',
      first?.code ?? 'POINT_VERIFICATION_FAILED',
      first?.message ?? 'Recovery point structural verification failed',
    )
  }
  const inspected = verification.points.find(
    (point) => point.pointId === verification.resolvedPointId,
  )
  if (!inspected?.structurallyHealthy) {
    throw new RecoveryFailure(
      'integrity',
      'POINT_NOT_STRUCTURALLY_HEALTHY',
      'Recovery point is unsafe',
    )
  }
  const partial = inspected.manifestHealth === 'partial'
  if (
    partial &&
    (!options.pointId ||
      !options.allowPartial ||
      options.partialConsent !== 'I_ACCEPT_PARTIAL_RECOVERY')
  ) {
    throw new RecoveryFailure(
      'configuration',
      'PARTIAL_RECOVERY_CONSENT_REQUIRED',
      'Partial recovery requires explicit dangerous consent and a concrete point ID',
    )
  }
  const repository = await openRepository(options.repositoryPath, {
    intent: 'read',
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
  })
  try {
    const discovery = await discoverVisiblePoints(repository)
    const point = discovery.points.find(
      (candidate) => candidate.id === verification.resolvedPointId,
    )
    if (!point) throw new Error('verified point disappeared')
    const loaded = await loadManifest(repository, point)
    if ((loaded.manifest.health === 'partial') !== partial) throw new Error('point health changed')
    return {
      repository,
      point,
      manifest: loaded.manifest,
      manifestFingerprint: loaded.fingerprint,
    }
  } catch (error) {
    repository.close()
    throw error
  }
}

function publicSources(sources: ManifestSourceV1[]): RecoverySourceSummary[] {
  return sources.map((source) => ({
    id: source.id,
    plugin: source.plugin,
    name: source.name,
    sensitivity: source.sensitivity,
    declaredPath: source.sensitivity === 'secret' ? '<redacted>' : source.declaredPath,
    status: source.status,
  }))
}

function publicPaths(entries: ManifestEntryV1[], sources: ManifestSourceV1[]): string[] {
  const sensitivity = new Map(sources.map((source) => [source.id, source.sensitivity]))
  return entries.map((entry) =>
    sensitivity.get(entry.sourceId) === 'secret'
      ? `${entry.sourceId}:<redacted>`
      : `${entry.sourceId}:${entry.relativePath}`,
  )
}

async function verifyStagedEntry(
  root: string,
  entry: StagedEntry,
  metadata: StageRecoveryOptions['metadata'],
): Promise<ClassifiedIssue[]> {
  const path = resolve(root, entry.stagingRelativePath)
  if (!pathUnder(root, path)) throw new Error('staging entry leaves root')
  if (entry.type === 'file') {
    const expectedHash = entry.contentHash as string
    const actual = await fingerprintFile(path)
    if (actual.hash !== expectedHash || actual.bytes !== entry.metadata.size) {
      throw new Error('staged file verification failed')
    }
  } else if (entry.type === 'symlink') {
    if ((await readLinkSafely(path)) !== entry.linkTarget) throw new Error('staged link mismatch')
  } else if ((await lstatIdentity(path))?.type !== 'directory') {
    throw new Error('staged directory mismatch')
  }
  return (await verifyMetadata(path, entry, metadata)).map((loss) =>
    issue(loss.code, 'partial', loss.message, 'Review metadata fidelity before apply'),
  )
}

export async function readStagingDescriptor(stagingPath: string): Promise<StagingDescriptor> {
  const content = await readDirectoryBoundFile(stagingPath, STAGING_DESCRIPTOR, 16 * 1024 * 1024)
  try {
    const parsed = JSON.parse(content.toString('utf8')) as Partial<StagingDescriptor>
    const keys = Object.keys(parsed).sort().join(',')
    const expectedKeys = [
      'createdAt',
      'entries',
      'formatVersion',
      'kind',
      'manifestFingerprint',
      'partialAccepted',
      'plugins',
      'pointCompletedAt',
      'pointId',
      'protection',
      'repositoryId',
      'selection',
      'selectionFingerprint',
      'sources',
      'stagingId',
      'status',
    ]
      .sort()
      .join(',')
    if (
      keys !== expectedKeys ||
      parsed.formatVersion !== 1 ||
      parsed.kind !== 'restore-staging' ||
      parsed.status !== 'verified' ||
      typeof parsed.stagingId !== 'string' ||
      typeof parsed.repositoryId !== 'string' ||
      typeof parsed.pointId !== 'string' ||
      (parsed.protection !== 'encrypted' && parsed.protection !== 'plaintext') ||
      !Array.isArray(parsed.entries) ||
      !Array.isArray(parsed.sources) ||
      !Array.isArray(parsed.plugins) ||
      !parsed.selection ||
      JSON.stringify(stableSelection(parsed.selection)) !== JSON.stringify(parsed.selection) ||
      parsed.selectionFingerprint !== hash(JSON.stringify(parsed.selection)) ||
      new Set(parsed.entries.map((entry) => entry.id)).size !== parsed.entries.length ||
      parsed.entries.some(
        (entry) =>
          !entry ||
          typeof entry.id !== 'string' ||
          typeof entry.sourceId !== 'string' ||
          typeof entry.relativePath !== 'string' ||
          typeof entry.stagingRelativePath !== 'string' ||
          (entry.selectionRole !== 'selected' && entry.selectionRole !== 'dependency') ||
          !pathUnder(
            stagingPath,
            resolve(stagingPath, safeRelativePath(entry.stagingRelativePath)),
          ),
      )
    ) {
      throw new Error('invalid staging descriptor')
    }
    return parsed as StagingDescriptor
  } finally {
    content.fill(0)
  }
}

export async function verifyStaging(
  stagingPath: string,
  metadata?: StageRecoveryOptions['metadata'],
): Promise<{ descriptor: StagingDescriptor; issues: ClassifiedIssue[] }> {
  await assertSafeDirectory(stagingPath)
  const descriptor = await readStagingDescriptor(stagingPath)
  const issues: ClassifiedIssue[] = []
  for (const entry of descriptor.entries) {
    safeRelativePath(entry.stagingRelativePath)
    issues.push(...(await verifyStagedEntry(stagingPath, entry, metadata)))
  }
  for (const entry of descriptor.entries.filter((candidate) => candidate.hardlinkTo)) {
    const anchor = descriptor.entries.find((candidate) => candidate.id === entry.hardlinkTo)
    const [current, anchorIdentity] = await Promise.all([
      lstatIdentity(resolve(stagingPath, entry.stagingRelativePath)),
      anchor ? lstatIdentity(resolve(stagingPath, anchor.stagingRelativePath)) : null,
    ])
    if (
      current?.type !== 'file' ||
      anchorIdentity?.type !== 'file' ||
      current.device !== anchorIdentity.device ||
      current.inode !== anchorIdentity.inode
    )
      throw new RecoveryFailure(
        'integrity',
        'STAGING_HARDLINK_MISMATCH',
        'A staged hardlink no longer shares identity with its authenticated anchor',
      )
  }
  return { descriptor, issues }
}

async function assertAuthenticatedDescriptorAgreement(input: {
  descriptor: StagingDescriptor
  stagingPath: string
  repositoryPath: string
  pointId: string
  manifest: RecoveryPointManifestV1
  manifestFingerprint: string
}): Promise<void> {
  const selected = selectEntries(input.manifest, input.descriptor.selection)
  const selectionFingerprint = hash(JSON.stringify(input.descriptor.selection))
  const expectedStagingId = `${input.pointId}-${selectionFingerprint.slice(0, 16)}`
  const absoluteStagingPath = resolve(input.stagingPath)
  const [canonicalStagingPath, canonicalRepositoryPath] = await Promise.all([
    realpath(absoluteStagingPath),
    realpath(resolve(input.repositoryPath)),
  ])
  if (pathsOverlap(canonicalStagingPath, canonicalRepositoryPath))
    throw new RecoveryFailure(
      'destination',
      'STAGING_REPOSITORY_OVERLAP',
      'Authenticated staging overlaps repository state',
    )
  const expectedPlugins = [...new Set(selected.sources.map((source) => source.plugin))].sort()
  const expectedSources = selected.sources.map((source) => ({
    id: source.id,
    plugin: source.plugin,
    name: source.name,
    sensitivity: source.sensitivity,
    status: source.status,
  }))
  const expectedEntries: StagedEntry[] = selected.entries.map((entry) => ({
    ...entry,
    stagingRelativePath: stageRelative(entry.sourceId, entry.relativePath),
    selectionRole: selected.selectedIds.has(entry.id) ? 'selected' : 'dependency',
  }))
  if (
    canonicalStagingPath !== absoluteStagingPath ||
    basename(canonicalStagingPath) !== expectedStagingId ||
    input.descriptor.stagingId !== expectedStagingId ||
    input.descriptor.repositoryId !== input.manifest.repositoryId ||
    input.descriptor.protection !== input.manifest.protection ||
    input.descriptor.pointId !== input.manifest.pointId ||
    input.descriptor.manifestFingerprint !== input.manifestFingerprint ||
    input.descriptor.selectionFingerprint !== selectionFingerprint ||
    input.descriptor.pointCompletedAt !== input.manifest.completedAt ||
    input.descriptor.createdAt !== input.manifest.completedAt ||
    JSON.stringify(input.descriptor.plugins) !== JSON.stringify(expectedPlugins) ||
    JSON.stringify(input.descriptor.sources) !== JSON.stringify(expectedSources) ||
    JSON.stringify(input.descriptor.entries) !== JSON.stringify(expectedEntries) ||
    input.descriptor.partialAccepted !== (input.manifest.health === 'partial')
  )
    throw new RecoveryFailure(
      'integrity',
      'STAGING_DESCRIPTOR_MISMATCH',
      'Staging descriptor does not match authenticated recovery data',
    )
}

export async function authenticateStaging(
  options: RecoveryRepositoryOptions,
  stagingPath: string,
  metadata?: StageRecoveryOptions['metadata'],
): Promise<{
  descriptor: StagingDescriptor
  manifest: RecoveryPointManifestV1
  issues: ClassifiedIssue[]
}> {
  const [canonicalStagingPath, canonicalRepositoryPath] = await Promise.all([
    realpath(resolve(stagingPath)),
    realpath(resolve(options.repositoryPath)),
  ])
  if (pathsOverlap(canonicalStagingPath, canonicalRepositoryPath))
    throw new RecoveryFailure(
      'destination',
      'STAGING_REPOSITORY_OVERLAP',
      'Authenticated staging overlaps repository state',
    )
  let staged: Awaited<ReturnType<typeof verifyStaging>>
  try {
    staged = await verifyStaging(stagingPath, metadata)
  } catch (error) {
    if (error instanceof RecoveryFailure) throw error
    throw new RecoveryFailure(
      'integrity',
      'STAGING_VERIFICATION_FAILED',
      'Staging content or metadata no longer matches its authenticated descriptor',
    )
  }
  const descriptor = staged.descriptor
  if (
    descriptor.repositoryId !== options.expectedRepositoryId ||
    descriptor.protection !== options.expectedProtection
  ) {
    throw new RecoveryFailure(
      'authentication',
      'STAGING_REPOSITORY_MISMATCH',
      'Staging belongs to another repository',
    )
  }
  const verification = await verifyV1Repository({
    repositoryPath: options.repositoryPath,
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
    selector: { kind: 'point', pointId: descriptor.pointId },
    scope: 'structural',
  })
  if (verification.state === 'failure') {
    throw new RecoveryFailure(
      'integrity',
      'STAGING_POINT_UNVERIFIED',
      'Staging source point is no longer verified',
    )
  }
  const repository = await openRepository(options.repositoryPath, {
    intent: 'read',
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
  })
  try {
    const discovered = await discoverVisiblePoints(repository)
    const point = discovered.points.find((candidate) => candidate.id === descriptor.pointId)
    if (!point) throw new Error('point missing')
    const loaded = await loadManifest(repository, point)
    await assertAuthenticatedDescriptorAgreement({
      descriptor,
      stagingPath,
      repositoryPath: repository.path,
      pointId: point.id,
      manifest: loaded.manifest,
      manifestFingerprint: loaded.fingerprint,
    })
    return { descriptor, manifest: loaded.manifest, issues: staged.issues }
  } finally {
    repository.close()
  }
}

export async function browseRecoveryPoints(options: RecoveryRepositoryOptions) {
  return verifyV1Repository({
    repositoryPath: options.repositoryPath,
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
    selector: { kind: 'all' },
    scope: 'structural',
  })
}

export async function stageRecovery(options: StageRecoveryOptions): Promise<RecoveryResult> {
  const started = safeNow(options.now)
  const selection = stableSelection(options.selection ?? { kind: 'all' })
  let repository: RepositoryHandle | undefined
  let pointId: string | null = options.pointId ?? null
  let stagingId: string | null = null
  let stagingPath: string | null = null
  let plugins: string[] = []
  let sourceSummaries: RecoverySourceSummary[] = []
  let selectedPaths: string[] = []
  const counts = { ...EMPTY_COUNTS }
  const issues: ClassifiedIssue[] = []
  try {
    const loaded = await resolvePoint(options)
    repository = loaded.repository
    pointId = loaded.point.id
    const selected = selectEntries(loaded.manifest, selection)
    plugins = [...new Set(selected.sources.map((source) => source.plugin))].sort()
    sourceSummaries = publicSources(selected.sources)
    selectedPaths = publicPaths(
      selected.entries.filter((entry) => selected.selectedIds.has(entry.id)),
      selected.sources,
    )
    counts.filesConsidered = selected.entries.filter(
      (entry) => entry.type === 'file' && selected.selectedIds.has(entry.id),
    ).length
    const selectionFingerprint = hash(JSON.stringify(selection))
    stagingId = `${loaded.point.id}-${selectionFingerprint.slice(0, 16)}`
    const stagingRoot = await realpath(resolve(options.stagingRoot))
    if (stagingRoot === '/' || pathsOverlap(stagingRoot, repository.path)) {
      throw new RecoveryFailure(
        'destination',
        'UNSAFE_STAGING_ROOT',
        'Staging root overlaps the repository or a broad system root',
      )
    }
    if (options.rejectOriginalPathOverlap) {
      const requestedStagingRoot = resolve(options.stagingRoot)
      for (const source of selected.sources.filter(
        (candidate) => candidate.recoveryScope !== 'inventory',
      )) {
        const declaredPath = resolve(expandPath(source.declaredPath))
        let canonicalSourcePath = declaredPath
        try {
          canonicalSourcePath = await realpath(declaredPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (
          pathsOverlap(requestedStagingRoot, declaredPath) ||
          pathsOverlap(stagingRoot, canonicalSourcePath) ||
          pathsOverlap(stagingRoot, declaredPath) ||
          pathsOverlap(requestedStagingRoot, canonicalSourcePath)
        ) {
          throw new RecoveryFailure(
            'destination',
            'STAGING_ORIGINAL_PATH_OVERLAP',
            'Staging root overlaps an authenticated original configuration path',
          )
        }
      }
    }
    const stagingRootIdentity = await assertSafeAbsoluteDirectoryChain(stagingRoot)
    stagingPath = join(stagingRoot, stagingId)
    const existing = await lstatIdentity(stagingPath)
    if (existing) {
      if (existing.type !== 'directory') throw new Error('staging path conflict')
      const verified = await verifyStaging(stagingPath, options.metadata)
      await assertAuthenticatedDescriptorAgreement({
        descriptor: verified.descriptor,
        stagingPath,
        repositoryPath: repository.path,
        pointId: loaded.point.id,
        manifest: loaded.manifest,
        manifestFingerprint: loaded.manifestFingerprint,
      })
      if (verified.descriptor.selectionFingerprint !== selectionFingerprint) {
        throw new RecoveryFailure(
          'destination',
          'STAGING_CONFLICT',
          'Existing staging is unrelated',
        )
      }
      counts.unchanged = counts.filesConsidered
      counts.bytesVerified = verified.descriptor.entries
        .filter((entry) => entry.type === 'file')
        .reduce((sum, entry) => sum + entry.metadata.size, 0)
      issues.push(...verified.issues)
    } else {
      const pending = join(stagingRoot, `.${stagingId}.pending`)
      await mkdirUnderRoot(stagingRoot, basename(pending))
      await mkdirUnderRoot(pending, 'payload')
      const stagedEntries: StagedEntry[] = selected.entries.map((entry) => ({
        ...entry,
        stagingRelativePath: stageRelative(entry.sourceId, entry.relativePath),
        selectionRole: selected.selectedIds.has(entry.id) ? 'selected' : 'dependency',
      }))
      const directories = stagedEntries
        .filter((entry) => entry.type === 'directory')
        .sort(
          (left, right) =>
            left.stagingRelativePath.split('/').length -
            right.stagingRelativePath.split('/').length,
        )
      for (const directory of directories)
        await mkdirUnderRoot(pending, directory.stagingRelativePath)
      for (const entry of stagedEntries.filter((entry) => entry.type !== 'directory')) {
        const destination = resolve(pending, entry.stagingRelativePath)
        await mkdirUnderRoot(pending, dirname(entry.stagingRelativePath))
        await options.beforeEntryPublish?.(entry, destination)
        if (entry.type === 'file' && !entry.hardlinkTo) {
          const blob = loaded.manifest.blobs.find((candidate) => candidate.id === entry.blobId)
          if (!blob || !repository.protector) throw new Error('blob reference missing')
          const protectedContent = await readDirectoryBoundFile(
            join(loaded.point.path, 'blobs'),
            basename(blob.path),
            MAX_PROTECTED_BLOB_BYTES,
          )
          let plaintext: Buffer | undefined
          try {
            plaintext = await repository.protector.open(protectedContent, {
              repositoryId: repository.descriptor.repositoryId,
              purpose: 'blob',
              objectId: blob.id,
            })
            const actual = hash(plaintext)
            if (plaintext.length !== blob.plaintextBytes || actual !== blob.contentHash) {
              throw new RecoveryFailure(
                'integrity',
                'BLOB_CONTENT_MISMATCH',
                'Recovery content is invalid',
              )
            }
            const existingEntry = await lstatIdentity(destination)
            if (existingEntry) {
              const existingContent = await readVerifiedFile(
                destination,
                blob.plaintextBytes,
                blob.contentHash,
              )
              existingContent.fill(0)
            } else {
              await atomicPublish({ kind: 'file', destination, expected: null, payload: plaintext })
            }
            if (entry.selectionRole === 'selected') counts.restored++
            counts.bytesRead += protectedContent.length
            counts.bytesWritten += plaintext.length
          } finally {
            protectedContent.fill(0)
            plaintext?.fill(0)
          }
        } else if (entry.type === 'symlink') {
          const existingEntry = await lstatIdentity(destination)
          if (existingEntry) {
            if (
              existingEntry.type !== 'symlink' ||
              (await readLinkSafely(destination)) !== entry.linkTarget
            ) {
              throw new RecoveryFailure(
                'integrity',
                'STAGING_PENDING_CONFLICT',
                'Pending staging is inconsistent',
              )
            }
          } else {
            await atomicPublish({
              kind: 'symlink',
              destination,
              expected: null,
              payload: entry.linkTarget as string,
            })
          }
        }
      }
      for (const entry of stagedEntries.filter((candidate) => candidate.hardlinkTo)) {
        const target = stagedEntries.find((candidate) => candidate.id === entry.hardlinkTo)
        if (!target) throw new Error('hardlink target missing')
        const destination = resolve(pending, entry.stagingRelativePath)
        const sourcePath = resolve(pending, target.stagingRelativePath)
        const sourceIdentity = await lstatIdentity(sourcePath)
        if (sourceIdentity?.type !== 'file') throw new Error('hardlink target invalid')
        const existingEntry = await lstatIdentity(destination)
        if (existingEntry) {
          if (
            existingEntry.type !== 'file' ||
            existingEntry.inode !== sourceIdentity.inode ||
            existingEntry.device !== sourceIdentity.device
          ) {
            throw new RecoveryFailure(
              'integrity',
              'STAGING_PENDING_CONFLICT',
              'Pending hardlink is inconsistent',
            )
          }
        } else {
          await atomicPublish({
            kind: 'hardlink',
            destination,
            expected: null,
            hardlinkSource: { path: sourcePath, identity: sourceIdentity },
          })
        }
        if (entry.selectionRole === 'selected') counts.restored++
        counts.bytesWritten += entry.metadata.size
      }
      for (const entry of stagedEntries.filter((candidate) => candidate.type !== 'directory')) {
        const destination = resolve(pending, entry.stagingRelativePath)
        const losses = [
          ...(entry.fidelityIssues ?? []).map((loss) => ({
            code: loss.code,
            message: loss.message,
          })),
          ...(await restoreMetadata(destination, entry, options.metadata)),
        ]
        for (const loss of losses) {
          issues.push(issue(loss.code, 'partial', loss.message, 'Review fidelity before apply'))
          counts.fidelityLoss++
        }
      }
      for (const entry of stagedEntries.filter((candidate) => candidate.type !== 'directory')) {
        const verificationIssues = await verifyStagedEntry(pending, entry, options.metadata)
        issues.push(...verificationIssues)
        counts.fidelityLoss += verificationIssues.length
        if (entry.type === 'file') counts.bytesVerified += entry.metadata.size
      }
      for (const entry of directories.sort(
        (left, right) =>
          right.stagingRelativePath.split('/').length - left.stagingRelativePath.split('/').length,
      )) {
        const destination = resolve(pending, entry.stagingRelativePath)
        const losses = [
          ...(entry.fidelityIssues ?? []).map((loss) => ({
            code: loss.code,
            message: loss.message,
          })),
          ...(await restoreMetadata(destination, entry, options.metadata)),
          ...(await verifyMetadata(destination, entry, options.metadata)),
        ]
        for (const loss of losses) {
          issues.push(issue(loss.code, 'partial', loss.message, 'Review fidelity before apply'))
          counts.fidelityLoss++
        }
      }
      const descriptor: StagingDescriptor = {
        formatVersion: 1,
        kind: 'restore-staging',
        stagingId,
        repositoryId: repository.descriptor.repositoryId,
        protection: repository.descriptor.protection,
        pointId: loaded.point.id,
        pointCompletedAt: loaded.manifest.completedAt,
        manifestFingerprint: loaded.manifestFingerprint,
        selectionFingerprint,
        selection,
        partialAccepted: loaded.manifest.health === 'partial',
        createdAt: loaded.manifest.completedAt,
        status: 'verified',
        plugins,
        sources: selected.sources.map((source) => ({
          id: source.id,
          plugin: source.plugin,
          name: source.name,
          sensitivity: source.sensitivity,
          status: source.status,
        })),
        entries: stagedEntries,
      }
      const descriptorPath = join(pending, STAGING_DESCRIPTOR)
      const descriptorPayload = `${JSON.stringify(descriptor)}\n`
      const existingDescriptor = await lstatIdentity(descriptorPath)
      if (existingDescriptor) {
        const content = await readBoundedRegularFile(descriptorPath, 16 * 1024 * 1024)
        try {
          if (content.toString('utf8') !== descriptorPayload)
            throw new Error('pending descriptor mismatch')
        } finally {
          content.fill(0)
        }
      } else {
        await atomicPublish({
          kind: 'file',
          destination: descriptorPath,
          expected: null,
          payload: descriptorPayload,
        })
      }
      await options.beforeStagePublish?.(pending, stagingPath)
      await atomicRenameDirectory(pending, stagingPath, stagingRootIdentity)
      const publishedVerification = await verifyStaging(stagingPath, options.metadata)
      const reboundDescriptor = await readStagingDescriptor(stagingPath)
      if (JSON.stringify(reboundDescriptor) !== JSON.stringify(publishedVerification.descriptor))
        throw new RecoveryFailure(
          'integrity',
          'STAGING_DESCRIPTOR_MISMATCH',
          'Published staging descriptor changed during verification',
        )
      await assertAuthenticatedDescriptorAgreement({
        descriptor: reboundDescriptor,
        stagingPath,
        repositoryPath: repository.path,
        pointId: loaded.point.id,
        manifest: loaded.manifest,
        manifestFingerprint: loaded.manifestFingerprint,
      })
      issues.push(...publishedVerification.issues)
    }
    await assertDirectoryIdentity(stagingRoot, stagingRootIdentity)
    const ended = safeNow(options.now)
    const partial = loaded.manifest.health === 'partial' || issues.length > 0
    return {
      operation: 'stage-recovery',
      state: partial ? 'partial' : 'success',
      category: partial ? 'partial' : 'success',
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      repositoryId: repository.descriptor.repositoryId,
      protection: repository.descriptor.protection,
      pointId,
      stagingId,
      stagingPath,
      partialAccepted: loaded.manifest.health === 'partial',
      selection,
      plugins,
      sources: sourceSummaries,
      selectedPaths,
      limitations: ['Per-entry atomic publication; whole-tree atomicity is not claimed'],
      counts,
      issues,
      nextAction: 'Review the verified staging result, then run apply in dry-run mode',
    }
  } catch (error) {
    counts.failed = Math.max(1, counts.filesConsidered - counts.restored - counts.unchanged)
    const failure = classify(error)
    return {
      operation: 'stage-recovery',
      state: failure.category === 'partial' ? 'partial' : 'failure',
      category: failure.category,
      startedAt: started.toISOString(),
      endedAt: safeNow(options.now).toISOString(),
      repositoryId: options.expectedRepositoryId,
      protection: options.expectedProtection,
      pointId,
      stagingId,
      stagingPath: null,
      partialAccepted: false,
      selection,
      plugins,
      sources: sourceSummaries,
      selectedPaths,
      limitations: ['No original path was modified'],
      counts,
      issues: [failure],
      nextAction: failure.nextAction ?? 'Resolve the reported issue and retry staging',
    }
  } finally {
    repository?.close()
  }
}

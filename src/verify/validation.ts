import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { sourceContractFingerprint } from '../catalog/scope.js'
import type { PointDescriptorV1, RecoveryPointManifestV1 } from './types.js'
import { MAX_PROTECTED_BLOB_BYTES, POINT_ID_PATTERN } from './types.js'

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
const boundedString = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((v) => !v.includes('\0'))
const instant = z.string().max(100).datetime({ offset: true })
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const decimal = z
  .string()
  .min(1)
  .max(100)
  .regex(/^-?[0-9]+$/)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const uuid = z.string().uuid()
const blobUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
const relativeEntryPath = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => {
    if (value === '.') return true
    return (
      !isAbsolute(value) &&
      value
        .split('/')
        .every((part) => part.length > 0 && part !== '.' && part !== '..' && !part.includes('\0'))
    )
  }, 'unsafe relative path')

const PointDescriptorSchema = z
  .object({
    formatVersion: z.literal(1),
    pointId: z.string().regex(POINT_ID_PATTERN),
    startedAt: instant,
    completedAt: instant,
    protection: z.enum(['encrypted', 'plaintext']),
    publication: z.literal('verified'),
    manifest: z.enum(['manifest.enc', 'manifest.json']),
  })
  .strict()

const XattrSchema = z
  .object({
    name: boundedString(1024),
    value: z
      .string()
      .max(2 * 1024 * 1024)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict()

const MetadataSchema = z
  .object({
    mode: z.number().int().min(0).max(0o7777),
    size: safeInteger,
    modifiedAtNs: decimal,
    createdAtNs: decimal.optional(),
    xattrs: z.array(XattrSchema).max(4096).optional(),
    flags: z.array(identifier).max(256).optional(),
  })
  .strict()

const FidelityIssueSchema = z
  .object({
    code: z.enum(['METADATA_XATTR_UNREADABLE', 'METADATA_FLAGS_UNREADABLE']),
    message: boundedString(2000),
  })
  .strict()

const EntrySchema = z
  .object({
    id: boundedString(8192),
    sourceId: boundedString(201),
    relativePath: relativeEntryPath,
    type: z.enum(['file', 'directory', 'symlink']),
    metadata: MetadataSchema,
    fidelityIssues: z.array(FidelityIssueSchema).max(2).optional(),
    linkTarget: z
      .string()
      .max(8192)
      .refine((value) => !value.includes('\0'))
      .optional(),
    hardlinkTo: boundedString(8192).optional(),
    contentHash: hash.optional(),
    blobId: uuid.optional(),
  })
  .strict()

const SourceSchema = z
  .object({
    id: boundedString(201),
    plugin: identifier,
    name: identifier,
    declaredPath: boundedString(4096),
    resolvedPath: boundedString(4096).refine(isAbsolute),
    requirement: z.enum(['required', 'optional']),
    sensitivity: z.enum(['public', 'private', 'secret']),
    expectedType: z.enum(['file', 'directory', 'symlink', 'any']),
    recoveryScope: identifier,
    consistencyGroup: identifier.optional(),
    includeEmptyDirectories: z.boolean(),
    status: z.enum(['captured', 'missing', 'failed', 'unstable']),
    entryIds: z.array(boundedString(8192)).max(100_000),
  })
  .strict()

const BlobSchema = z
  .object({
    id: blobUuid,
    entryId: boundedString(8192),
    path: z.string().min(1).max(150),
    contentHash: hash,
    plaintextBytes: safeInteger.max(64 * 1024 * 1024),
    protectedBytes: safeInteger.max(MAX_PROTECTED_BLOB_BYTES),
  })
  .strict()

const WarningSchema = z
  .object({
    code: boundedString(100),
    sourceId: boundedString(201),
    message: boundedString(2000),
    severity: z.enum(['warning', 'partial', 'failure']),
  })
  .strict()

const AcceptanceSchema = z
  .object({
    repositoryId: uuid,
    sourceId: boundedString(201),
    sourceContractFingerprint: hash,
    acceptedAt: instant,
  })
  .strict()

const ManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    pointId: z.string().regex(POINT_ID_PATTERN),
    startedAt: instant,
    completedAt: instant,
    sourceHost: z
      .object({
        hostname: boundedString(255),
        platform: boundedString(100),
        osRelease: boundedString(100),
        architecture: boundedString(100),
      })
      .strict(),
    cliVersion: boundedString(100),
    repositoryId: uuid,
    protection: z.enum(['encrypted', 'plaintext']),
    health: z.enum(['healthy', 'partial']),
    verification: z.literal('content-readback'),
    plugins: z.array(identifier).max(256),
    sources: z.array(SourceSchema).max(256),
    entries: z.array(EntrySchema).max(100_000),
    blobs: z.array(BlobSchema).max(100_000),
    warnings: z.array(WarningSchema).max(100_000),
    consistencyGroupsFailed: z.array(identifier).max(256),
    plaintextSecretAcceptances: z.array(AcceptanceSchema).max(256),
  })
  .strict()

export class V1ValidationError extends Error {
  readonly code: string

  constructor(code: string) {
    super('Recovery point metadata is invalid')
    this.name = 'V1ValidationError'
    this.code = code
  }
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

export function parsePointDescriptorV1(value: unknown): PointDescriptorV1 {
  const parsed = PointDescriptorSchema.safeParse(value)
  if (!parsed.success) throw new V1ValidationError('INVALID_POINT_DESCRIPTOR')
  const descriptor = parsed.data
  if (
    Date.parse(descriptor.completedAt) < Date.parse(descriptor.startedAt) ||
    descriptor.manifest !==
      (descriptor.protection === 'encrypted' ? 'manifest.enc' : 'manifest.json')
  ) {
    throw new V1ValidationError('INVALID_POINT_DESCRIPTOR')
  }
  return descriptor
}

export function parseRecoveryPointManifestV1(value: unknown): RecoveryPointManifestV1 {
  const parsed = ManifestSchema.safeParse(value)
  if (!parsed.success) throw new V1ValidationError('INVALID_POINT_MANIFEST')
  const manifest = parsed.data
  if (
    Date.parse(manifest.completedAt) < Date.parse(manifest.startedAt) ||
    !unique(manifest.plugins) ||
    !unique(manifest.sources.map((source) => source.id)) ||
    !unique(manifest.entries.map((entry) => entry.id)) ||
    !unique(manifest.blobs.map((blob) => blob.id)) ||
    !unique(manifest.blobs.map((blob) => blob.entryId)) ||
    !unique(manifest.consistencyGroupsFailed)
  ) {
    throw new V1ValidationError('INVALID_POINT_MANIFEST')
  }

  const plugins = new Set(manifest.plugins)
  const sources = new Map(manifest.sources.map((source) => [source.id, source]))
  const entries = new Map(manifest.entries.map((entry) => [entry.id, entry]))
  const blobs = new Map(manifest.blobs.map((blob) => [blob.id, blob]))

  for (const source of manifest.sources) {
    const referencedEntries = new Set(source.entryIds)
    if (
      source.id !== `${source.plugin}:${source.name}` ||
      !plugins.has(source.plugin) ||
      !unique(source.entryIds)
    ) {
      throw new V1ValidationError('INVALID_POINT_REFERENCES')
    }
    const actual = manifest.entries
      .filter((entry) => entry.sourceId === source.id)
      .map((entry) => entry.id)
    if (
      actual.length !== source.entryIds.length ||
      actual.some((id) => !referencedEntries.has(id))
    ) {
      throw new V1ValidationError('INVALID_POINT_REFERENCES')
    }
    if (source.requirement === 'required' && source.status !== 'captured') {
      throw new V1ValidationError('INVALID_POINT_HEALTH')
    }
    if (source.status !== 'captured' && source.entryIds.length > 0) {
      throw new V1ValidationError('INVALID_POINT_REFERENCES')
    }
  }

  for (const entry of manifest.entries) {
    if (!sources.has(entry.sourceId) || entry.id !== `${entry.sourceId}:${entry.relativePath}`) {
      throw new V1ValidationError('INVALID_POINT_REFERENCES')
    }
    const blob = entry.blobId ? blobs.get(entry.blobId) : undefined
    const hardlink = entry.hardlinkTo ? entries.get(entry.hardlinkTo) : undefined
    if (
      (entry.metadata.xattrs &&
        !unique(entry.metadata.xattrs.map((attribute) => attribute.name))) ||
      (entry.metadata.flags && !unique(entry.metadata.flags))
    ) {
      throw new V1ValidationError('DUPLICATE_ENTRY_METADATA')
    }
    if (entry.type === 'file') {
      if (
        !entry.contentHash ||
        Boolean(entry.blobId) === Boolean(entry.hardlinkTo) ||
        entry.linkTarget !== undefined
      ) {
        throw new V1ValidationError('INVALID_POINT_ENTRY')
      }
      if (
        entry.blobId &&
        (!blob ||
          blob.entryId !== entry.id ||
          blob.contentHash !== entry.contentHash ||
          blob.plaintextBytes !== entry.metadata.size)
      ) {
        throw new V1ValidationError('INVALID_POINT_REFERENCES')
      }
      if (
        entry.hardlinkTo &&
        (!hardlink ||
          hardlink === entry ||
          hardlink.type !== 'file' ||
          !hardlink.blobId ||
          hardlink.sourceId !== entry.sourceId ||
          hardlink.contentHash !== entry.contentHash ||
          hardlink.metadata.size !== entry.metadata.size)
      ) {
        throw new V1ValidationError('INVALID_HARDLINK_REFERENCE')
      }
    } else if (
      entry.contentHash !== undefined ||
      entry.blobId !== undefined ||
      entry.hardlinkTo !== undefined ||
      (entry.type === 'symlink' ? entry.linkTarget === undefined : entry.linkTarget !== undefined)
    ) {
      throw new V1ValidationError('INVALID_POINT_ENTRY')
    }
  }

  for (const blob of manifest.blobs) {
    if (blob.path !== `blobs/${blob.id}` || entries.get(blob.entryId)?.blobId !== blob.id) {
      throw new V1ValidationError('UNSAFE_BLOB_PATH')
    }
  }
  const groups = new Set(manifest.sources.flatMap((source) => source.consistencyGroup ?? []))
  if (manifest.consistencyGroupsFailed.some((group) => !groups.has(group))) {
    throw new V1ValidationError('INVALID_POINT_REFERENCES')
  }
  if (
    manifest.warnings.some(
      (warning) => !sources.has(warning.sourceId) && !groups.has(warning.sourceId),
    )
  ) {
    throw new V1ValidationError('INVALID_POINT_REFERENCES')
  }
  if (
    manifest.health === 'healthy' &&
    (manifest.warnings.some((warning) => warning.severity !== 'warning') ||
      manifest.consistencyGroupsFailed.length > 0 ||
      manifest.sources.some(
        (source) => source.status !== 'captured' && source.status !== 'missing',
      ))
  ) {
    throw new V1ValidationError('INVALID_POINT_HEALTH')
  }
  if (manifest.protection === 'encrypted' && manifest.plaintextSecretAcceptances.length > 0) {
    throw new V1ValidationError('INVALID_POINT_PROTECTION')
  }
  const acceptanceSourceIds = manifest.plaintextSecretAcceptances.map(
    (acceptance) => acceptance.sourceId,
  )
  const sourceFingerprints = new Map(
    manifest.sources.map((source) => [
      source.id,
      sourceContractFingerprint({
        id: source.id,
        plugin: source.plugin,
        name: source.name,
        declaredPath: source.declaredPath,
        path: source.resolvedPath,
        requirement: source.requirement,
        sensitivity: source.sensitivity,
        expectedType: source.expectedType,
        recoveryScope: source.recoveryScope,
        ...(source.consistencyGroup ? { consistencyGroup: source.consistencyGroup } : {}),
        includeEmptyDirectories: source.includeEmptyDirectories,
      }),
    ]),
  )
  const secretSourceIds = manifest.sources
    .filter((source) => source.sensitivity === 'secret')
    .map((source) => source.id)
  if (
    !unique(acceptanceSourceIds) ||
    manifest.plaintextSecretAcceptances.some(
      (acceptance) =>
        acceptance.repositoryId !== manifest.repositoryId ||
        sources.get(acceptance.sourceId)?.sensitivity !== 'secret' ||
        sourceFingerprints.get(acceptance.sourceId) !== acceptance.sourceContractFingerprint ||
        Date.parse(acceptance.acceptedAt) > Date.parse(manifest.startedAt) ||
        Date.parse(acceptance.acceptedAt) > Date.parse(manifest.completedAt),
    ) ||
    (manifest.protection === 'plaintext' &&
      (acceptanceSourceIds.length !== secretSourceIds.length ||
        secretSourceIds.some((sourceId) => !acceptanceSourceIds.includes(sourceId))))
  ) {
    throw new V1ValidationError('INVALID_POINT_REFERENCES')
  }
  return manifest
}

export function assertDescriptorManifestAgreement(
  descriptor: PointDescriptorV1,
  manifest: RecoveryPointManifestV1,
  directoryName: string,
  repositoryId: string,
  protection: 'encrypted' | 'plaintext',
): void {
  if (
    directoryName !== descriptor.pointId ||
    descriptor.pointId !== manifest.pointId ||
    descriptor.startedAt !== manifest.startedAt ||
    descriptor.completedAt !== manifest.completedAt ||
    descriptor.protection !== protection ||
    manifest.protection !== protection ||
    manifest.repositoryId !== repositoryId ||
    descriptor.formatVersion !== manifest.formatVersion
  ) {
    throw new V1ValidationError('POINT_DESCRIPTOR_MANIFEST_MISMATCH')
  }
}

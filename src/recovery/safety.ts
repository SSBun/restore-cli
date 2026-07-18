import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { open, opendir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { ContentProtector } from '../protection/index.js'
import type { ProtectionMode } from '../repository/index.js'
import type { ManifestEntryV1 } from '../verify/index.js'
import { captureCurrentMetadata } from './metadata.js'
import {
  MAX_RECOVERY_FILE_BYTES,
  assertSafeDirectory,
  atomicPublish,
  lstatIdentity,
  mkdirUnderRoot,
  pathUnder,
  readDirectoryBoundFile,
  readLinkSafely,
  readVerifiedFile,
} from './safe-io.js'
import type { PathIdentity } from './safe-io.js'
import type {
  MetadataOptions,
  RecoveryDirectoryBinding,
  SafetyProtectionDescriptor,
  StagedEntry,
  StagingDescriptor,
} from './types.js'

const MAX_SAFETY_ENTRIES = 100_000
const MAX_SAFETY_MANIFEST_BYTES = 16 * 1024 * 1024

export class SafetyResidueError extends Error {
  readonly code = 'INCOMPLETE_SAFETY_RESIDUE'
  readonly nextAction =
    'Retry with the original reviewed apply ID, or explicitly inspect and resolve the prior Safety attempt'
}

export interface SafetyCaptureItem {
  entry: StagedEntry
  targetPath: string
  targetLabel: string
  externalParent: RecoveryDirectoryBinding
}

export interface SafetyEntry {
  entryId: string
  sourceId: string
  targetPath: string
  targetLabel: string
  externalParent: RecoveryDirectoryBinding
  before:
    | { state: 'absent' }
    | {
        state: 'present'
        type: ManifestEntryV1['type']
        metadata: ManifestEntryV1['metadata']
        device: string
        inode: string
        changedAtNs: string
        contentHash?: string
        plaintextBytes?: number
        blobId?: string
        linkTarget?: string
        hardlinkToEntryId?: string
      }
}

export interface SafetyPlanItem {
  entryId: string
  sourceId: string
  targetPath: string
  status: 'pending' | 'unchanged' | 'skipped'
  externalParent: RecoveryDirectoryBinding
  expected: null | {
    device: string
    inode: string
    type: ManifestEntryV1['type']
    size: string
    modifiedAtNs: string
    changedAtNs: string
  }
}

export interface SafetyManifest {
  formatVersion: 1
  kind: 'restore-safety-point'
  safetyId: string
  applyId: string
  repositoryId: string
  protection: ProtectionMode
  pointId: string
  stagingId: string
  stagingPathFingerprint: string
  planFingerprint: string
  createdAt: string
  planItems: SafetyPlanItem[]
  entries: SafetyEntry[]
}

interface SafetyLeaseArtifact {
  name: string
  identity: PathIdentity
  protectedHash: string
}

interface SafetyLeaseControl extends SafetyLeaseArtifact {
  handle: FileHandle
}

export interface SafetyLease {
  rootPath: string
  rootIdentity: PathIdentity
  rootHandle: FileHandle
  manifestFingerprint: string
  artifacts: SafetyLeaseArtifact[]
  artifactByName: Map<string, SafetyLeaseArtifact>
  controls: SafetyLeaseControl[]
  blobByEntryId: Map<string, string>
  heldDescriptorCount: number
  closed: boolean
}

export interface SafetyLeaseMetrics {
  fullValidations: number
  entryValidations: number
  controlByteReads: number
  blobByteReads: number
  artifactLookups: number
  currentHeldDescriptors: number
  peakHeldDescriptors: number
}

const safetyLeaseMetrics: SafetyLeaseMetrics = {
  fullValidations: 0,
  entryValidations: 0,
  controlByteReads: 0,
  blobByteReads: 0,
  artifactLookups: 0,
  currentHeldDescriptors: 0,
  peakHeldDescriptors: 0,
}

export function resetSafetyLeaseMetricsForTests(): void {
  for (const key of Object.keys(safetyLeaseMetrics) as Array<keyof SafetyLeaseMetrics>)
    safetyLeaseMetrics[key] = 0
}

export function readSafetyLeaseMetricsForTests(): Readonly<SafetyLeaseMetrics> {
  return { ...safetyLeaseMetrics }
}

// This is a cooperative same-UID integrity boundary, not an OS-enforced mandatory lock.
// Callers preflight all injected hooks, then use the held control identities and current-entry
// blob check at each mutation boundary; arbitrary external same-UID writes are detected at the
// next boundary and by bounded full checkpoints.

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function safetyRoot(stagingPath: string, safetyId: string): string {
  return join(stagingPath, '.restore-control', 'safety', safetyId)
}

async function writeProtected(directory: string, name: string, content: Uint8Array): Promise<void> {
  const path = join(directory, name)
  const existing = await lstatIdentity(path)
  if (existing) {
    const current = await readDirectoryBoundFile(directory, name, content.length + 1)
    try {
      if (!current.equals(content)) throw new Error('protected safety data differs')
    } finally {
      current.fill(0)
    }
    return
  }
  await atomicPublish({ kind: 'file', destination: path, expected: null, payload: content })
}

async function writeOrVerifyProtectedBlob(input: {
  directory: string
  name: string
  plaintext: Uint8Array
  protector: ContentProtector
  repositoryId: string
  objectId: string
}): Promise<void> {
  const path = join(input.directory, input.name)
  if (await lstatIdentity(path)) {
    const protectedContent = await readDirectoryBoundFile(
      input.directory,
      input.name,
      MAX_RECOVERY_FILE_BYTES + 1024,
    )
    let recovered: Buffer | undefined
    try {
      recovered = await input.protector.open(protectedContent, {
        repositoryId: input.repositoryId,
        purpose: 'blob',
        objectId: input.objectId,
      })
      if (!recovered.equals(input.plaintext)) throw new Error('protected safety blob differs')
    } finally {
      protectedContent.fill(0)
      recovered?.fill(0)
    }
    return
  }
  const protectedContent = await input.protector.seal(input.plaintext, {
    repositoryId: input.repositoryId,
    purpose: 'blob',
    objectId: input.objectId,
  })
  try {
    await atomicPublish({
      kind: 'file',
      destination: path,
      expected: null,
      payload: protectedContent,
    })
  } finally {
    protectedContent.fill(0)
  }
}

async function captureEntry(
  item: SafetyCaptureItem,
  metadataOptions?: MetadataOptions,
): Promise<SafetyEntry> {
  const before = await lstatIdentity(item.targetPath)
  if (!before) {
    return {
      entryId: item.entry.id,
      sourceId: item.entry.sourceId,
      targetPath: item.targetPath,
      targetLabel: item.targetLabel,
      externalParent: item.externalParent,
      before: { state: 'absent' },
    }
  }
  const type = before.type
  const metadata = await captureCurrentMetadata(item.targetPath, type, metadataOptions)
  const assertUnchanged = async (): Promise<void> => {
    const after = await lstatIdentity(item.targetPath)
    if (
      !after ||
      after.device !== before.device ||
      after.inode !== before.inode ||
      after.size !== before.size ||
      after.modifiedAtNs !== before.modifiedAtNs ||
      after.changedAtNs !== before.changedAtNs
    )
      throw new Error('safety source changed during capture')
  }
  const common = {
    state: 'present' as const,
    type,
    metadata,
    device: before.device.toString(),
    inode: before.inode.toString(),
    changedAtNs: before.changedAtNs.toString(),
  }
  if (type === 'directory') {
    await assertUnchanged()
    return {
      entryId: item.entry.id,
      sourceId: item.entry.sourceId,
      targetPath: item.targetPath,
      targetLabel: item.targetLabel,
      externalParent: item.externalParent,
      before: common,
    }
  }
  if (type === 'symlink') {
    const linkTarget = await readLinkSafely(item.targetPath)
    await assertUnchanged()
    return {
      entryId: item.entry.id,
      sourceId: item.entry.sourceId,
      targetPath: item.targetPath,
      targetLabel: item.targetLabel,
      externalParent: item.externalParent,
      before: { ...common, linkTarget },
    }
  }
  const content = await readDirectoryBoundFile(
    resolve(item.targetPath, '..'),
    basename(item.targetPath),
    MAX_RECOVERY_FILE_BYTES,
  )
  try {
    const blobId = `safety-${hash(item.entry.id).slice(0, 32)}`
    const contentHash = hash(content)
    await assertUnchanged()
    return {
      entryId: item.entry.id,
      sourceId: item.entry.sourceId,
      targetPath: item.targetPath,
      targetLabel: item.targetLabel,
      externalParent: item.externalParent,
      before: {
        ...common,
        contentHash,
        plaintextBytes: content.length,
        blobId,
      },
    }
  } finally {
    content.fill(0)
  }
}

function parseSafetyManifest(value: unknown): SafetyManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid safety point')
  const candidate = value as Partial<SafetyManifest>
  const exact = (actual: object, expected: string[]) =>
    Object.keys(actual).sort().join(',') === [...expected].sort().join(',')
  if (
    !exact(candidate, [
      'formatVersion',
      'kind',
      'safetyId',
      'applyId',
      'repositoryId',
      'protection',
      'pointId',
      'stagingId',
      'stagingPathFingerprint',
      'planFingerprint',
      'createdAt',
      'planItems',
      'entries',
    ]) ||
    candidate.formatVersion !== 1 ||
    candidate.kind !== 'restore-safety-point' ||
    typeof candidate.safetyId !== 'string' ||
    typeof candidate.applyId !== 'string' ||
    typeof candidate.repositoryId !== 'string' ||
    (candidate.protection !== 'encrypted' && candidate.protection !== 'plaintext') ||
    typeof candidate.pointId !== 'string' ||
    typeof candidate.stagingId !== 'string' ||
    typeof candidate.stagingPathFingerprint !== 'string' ||
    typeof candidate.planFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.planFingerprint) ||
    !/^[0-9a-f]{64}$/.test(candidate.stagingPathFingerprint) ||
    !Number.isFinite(Date.parse(candidate.createdAt ?? '')) ||
    !Array.isArray(candidate.planItems) ||
    candidate.planItems.length > MAX_SAFETY_ENTRIES ||
    new Set(candidate.planItems.map((item) => item.entryId)).size !== candidate.planItems.length ||
    candidate.planItems.some(
      (item) =>
        !item ||
        !exact(item, [
          'entryId',
          'sourceId',
          'targetPath',
          'status',
          'externalParent',
          'expected',
        ]) ||
        typeof item.entryId !== 'string' ||
        typeof item.sourceId !== 'string' ||
        !isAbsolute(item.targetPath) ||
        resolve(item.targetPath) !== item.targetPath ||
        !['pending', 'unchanged', 'skipped'].includes(item.status) ||
        !item.externalParent ||
        !exact(item.externalParent, ['path', 'device', 'inode']) ||
        !isAbsolute(item.externalParent.path) ||
        resolve(item.externalParent.path) !== item.externalParent.path ||
        !pathUnder(item.externalParent.path, item.targetPath) ||
        !/^\d+$/.test(item.externalParent.device) ||
        !/^\d+$/.test(item.externalParent.inode) ||
        (item.expected !== null &&
          (!exact(item.expected, [
            'device',
            'inode',
            'type',
            'size',
            'modifiedAtNs',
            'changedAtNs',
          ]) ||
            !['file', 'directory', 'symlink'].includes(item.expected.type) ||
            ![
              item.expected.device,
              item.expected.inode,
              item.expected.size,
              item.expected.modifiedAtNs,
              item.expected.changedAtNs,
            ].every((value) => typeof value === 'string' && /^\d+$/.test(value)))),
    ) ||
    !Array.isArray(candidate.entries) ||
    candidate.entries.length > MAX_SAFETY_ENTRIES ||
    new Set(candidate.entries.map((entry) => entry.entryId)).size !== candidate.entries.length ||
    candidate.entries.some(
      (entry) =>
        !entry ||
        typeof entry.entryId !== 'string' ||
        typeof entry.sourceId !== 'string' ||
        !isAbsolute(entry.targetPath) ||
        resolve(entry.targetPath) !== entry.targetPath ||
        entry.targetPath.includes('\0') ||
        typeof entry.targetLabel !== 'string' ||
        !entry.before ||
        !entry.externalParent ||
        !exact(entry.externalParent, ['path', 'device', 'inode']) ||
        !isAbsolute(entry.externalParent.path) ||
        resolve(entry.externalParent.path) !== entry.externalParent.path ||
        !pathUnder(entry.externalParent.path, entry.targetPath) ||
        !/^\d+$/.test(entry.externalParent.device) ||
        !/^\d+$/.test(entry.externalParent.inode) ||
        !exact(entry, [
          'entryId',
          'sourceId',
          'targetPath',
          'targetLabel',
          'externalParent',
          'before',
        ]) ||
        (entry.before.state !== 'absent' && entry.before.state !== 'present') ||
        (entry.before.state === 'absent'
          ? !exact(entry.before, ['state'])
          : !['file', 'directory', 'symlink'].includes(entry.before.type) ||
            typeof entry.before.device !== 'string' ||
            typeof entry.before.inode !== 'string' ||
            typeof entry.before.changedAtNs !== 'string' ||
            !entry.before.metadata ||
            !exact(entry.before.metadata, [
              'mode',
              'size',
              'modifiedAtNs',
              ...(entry.before.metadata.createdAtNs === undefined ? [] : ['createdAtNs']),
              ...(entry.before.metadata.xattrs === undefined ? [] : ['xattrs']),
              ...(entry.before.metadata.flags === undefined ? [] : ['flags']),
            ]) ||
            !Number.isSafeInteger(entry.before.metadata.mode) ||
            !Number.isSafeInteger(entry.before.metadata.size) ||
            typeof entry.before.metadata.modifiedAtNs !== 'string' ||
            (entry.before.metadata.createdAtNs !== undefined &&
              typeof entry.before.metadata.createdAtNs !== 'string') ||
            (entry.before.metadata.flags !== undefined &&
              (!Array.isArray(entry.before.metadata.flags) ||
                entry.before.metadata.flags.some((flag) => typeof flag !== 'string'))) ||
            (entry.before.metadata.xattrs !== undefined &&
              (!Array.isArray(entry.before.metadata.xattrs) ||
                entry.before.metadata.xattrs.some(
                  (attribute) =>
                    !attribute ||
                    !exact(attribute, ['name', 'value']) ||
                    typeof attribute.name !== 'string' ||
                    typeof attribute.value !== 'string',
                ))) ||
            (entry.before.type === 'file'
              ? !exact(entry.before, [
                  'state',
                  'type',
                  'metadata',
                  'device',
                  'inode',
                  'changedAtNs',
                  'contentHash',
                  'plaintextBytes',
                  'blobId',
                  ...(entry.before.hardlinkToEntryId === undefined ? [] : ['hardlinkToEntryId']),
                ]) ||
                !/^[0-9a-f]{64}$/.test(entry.before.contentHash ?? '') ||
                !Number.isSafeInteger(entry.before.plaintextBytes) ||
                typeof entry.before.blobId !== 'string'
              : entry.before.type === 'symlink'
                ? !exact(entry.before, [
                    'state',
                    'type',
                    'metadata',
                    'device',
                    'inode',
                    'changedAtNs',
                    'linkTarget',
                  ]) || typeof entry.before.linkTarget !== 'string'
                : !exact(entry.before, [
                    'state',
                    'type',
                    'metadata',
                    'device',
                    'inode',
                    'changedAtNs',
                  ]))),
    )
  ) {
    throw new Error('invalid safety point')
  }
  const manifest = candidate as SafetyManifest
  const planByEntryId = new Map(manifest.planItems.map((item) => [item.entryId, item]))
  if (
    !/^safety-[0-9a-f]{32}$/.test(manifest.safetyId) ||
    !/^apply-[0-9a-f]{32}$/.test(manifest.applyId) ||
    manifest.entries.length !==
      manifest.planItems.filter((item) => item.status === 'pending').length ||
    manifest.entries.some((entry) => {
      const planItem = planByEntryId.get(entry.entryId)
      if (
        !planItem ||
        planItem.status !== 'pending' ||
        planItem.sourceId !== entry.sourceId ||
        planItem.targetPath !== entry.targetPath ||
        JSON.stringify(planItem.externalParent) !== JSON.stringify(entry.externalParent)
      )
        return true
      if (entry.before.state !== 'present' || entry.before.type !== 'file') return false
      const fileBefore = entry.before
      if (fileBefore.blobId !== `safety-${hash(entry.entryId).slice(0, 32)}`) return true
      if (fileBefore.hardlinkToEntryId === undefined) return false
      const anchor = manifest.entries.find(
        (candidateEntry) => candidateEntry.entryId === fileBefore.hardlinkToEntryId,
      )
      return (
        !anchor ||
        anchor.before.state !== 'present' ||
        anchor.before.type !== 'file' ||
        anchor.before.device !== fileBefore.device ||
        anchor.before.inode !== fileBefore.inode
      )
    })
  )
    throw new Error('invalid safety point')
  return manifest
}

function hasExactKeys(actual: object, expected: string[]): boolean {
  return Object.keys(actual).sort().join(',') === [...expected].sort().join(',')
}

async function validateSafetyProtection(root: string, manifest: SafetyManifest): Promise<void> {
  const content = await readDirectoryBoundFile(root, 'protection.json', 64 * 1024)
  try {
    const protection = JSON.parse(content.toString('utf8')) as Partial<SafetyProtectionDescriptor>
    if (
      !protection ||
      !hasExactKeys(protection, [
        'formatVersion',
        'kind',
        'safetyId',
        'repositoryId',
        'pointId',
        'stagingId',
        'planFingerprint',
        'active',
        'createdAt',
      ]) ||
      protection.formatVersion !== 1 ||
      protection.kind !== 'restore-safety-protection' ||
      protection.safetyId !== manifest.safetyId ||
      protection.repositoryId !== manifest.repositoryId ||
      protection.pointId !== manifest.pointId ||
      protection.stagingId !== manifest.stagingId ||
      protection.planFingerprint !== manifest.planFingerprint ||
      protection.active !== true ||
      protection.createdAt !== manifest.createdAt
    )
      throw new Error('invalid Safety protection')
  } catch {
    throw new SafetyResidueError('Invalid Safety protection residue blocks recovery')
  } finally {
    content.fill(0)
  }
}

async function readValidSafetyRelease(
  root: string,
  manifest: SafetyManifest,
  protector: ContentProtector,
): Promise<boolean> {
  if (!(await lstatIdentity(join(root, 'release.protected')))) return false
  const protectedRelease = await readDirectoryBoundFile(root, 'release.protected', 64 * 1024)
  let plaintext: Buffer | undefined
  try {
    plaintext = await protector.open(protectedRelease, {
      repositoryId: manifest.repositoryId,
      purpose: 'manifest',
      objectId: `${manifest.safetyId}:release`,
    })
    const release = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>
    if (
      !release ||
      !hasExactKeys(release, [
        'formatVersion',
        'kind',
        'safetyId',
        'repositoryId',
        'pointId',
        'planFingerprint',
        'reason',
        'releasedAt',
      ]) ||
      release.formatVersion !== 1 ||
      release.kind !== 'restore-safety-release' ||
      release.safetyId !== manifest.safetyId ||
      release.repositoryId !== manifest.repositoryId ||
      release.pointId !== manifest.pointId ||
      release.planFingerprint !== manifest.planFingerprint ||
      (release.reason !== 'post-apply-verified' && release.reason !== 'rollback-verified') ||
      typeof release.releasedAt !== 'string' ||
      !Number.isFinite(Date.parse(release.releasedAt))
    )
      throw new Error('invalid Safety release')
    return true
  } catch {
    throw new SafetyResidueError('Invalid Safety release residue blocks recovery')
  } finally {
    protectedRelease.fill(0)
    plaintext?.fill(0)
  }
}

async function validateFinalSafetyRoot(
  root: string,
  manifest: SafetyManifest,
  protector: ContentProtector,
  allowMissingProtection: boolean,
): Promise<void> {
  const core = new Set([
    'intent.protected',
    'manifest.protected',
    ...manifest.entries
      .filter((entry) => entry.before.state === 'present' && entry.before.type === 'file')
      .map((entry) => `${(entry.before as { blobId: string }).blobId}.blob`),
  ])
  const directory = await opendir(root)
  const actual = new Set<string>()
  try {
    for await (const entry of directory) {
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new SafetyResidueError('Invalid Safety child type blocks recovery')
      actual.add(entry.name)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  const hasProtection = actual.has('protection.json')
  const hasRelease = actual.has('release.protected')
  if (!hasProtection && !allowMissingProtection)
    throw new SafetyResidueError('Finalized Safety is missing its protection state')
  if (hasRelease && !hasProtection)
    throw new SafetyResidueError('Safety release is missing active protection state')
  const expected = new Set(core)
  if (hasProtection) expected.add('protection.json')
  if (hasRelease) expected.add('release.protected')
  if (
    actual.size !== expected.size ||
    [...expected].some((name) => !actual.has(name)) ||
    [...actual].some((name) => !expected.has(name))
  )
    throw new SafetyResidueError('Unexpected or missing Safety children block recovery')
  if (hasProtection) await validateSafetyProtection(root, manifest)
  if (hasRelease) await readValidSafetyRelease(root, manifest, protector)
}

export async function readSafetyPoint(
  stagingPath: string,
  safetyId: string,
  repositoryId: string,
  protector: ContentProtector,
  options: { allowMissingProtection?: boolean } = {},
): Promise<SafetyManifest> {
  const root = safetyRoot(stagingPath, safetyId)
  const protectedManifest = await readDirectoryBoundFile(
    root,
    'manifest.protected',
    MAX_SAFETY_MANIFEST_BYTES,
  )
  let plaintext: Buffer | undefined
  try {
    plaintext = await protector.open(protectedManifest, {
      repositoryId,
      purpose: 'manifest',
      objectId: safetyId,
    })
    const manifest = parseSafetyManifest(JSON.parse(plaintext.toString('utf8')))
    if (manifest.repositoryId !== repositoryId || manifest.safetyId !== safetyId)
      throw new Error('safety binding mismatch')
    for (const entry of manifest.entries) {
      if (entry.before.state !== 'present' || entry.before.type !== 'file') continue
      if (
        !entry.before.blobId ||
        entry.before.plaintextBytes === undefined ||
        !entry.before.contentHash
      )
        throw new Error('invalid safety blob')
      const protectedBlob = await readDirectoryBoundFile(
        root,
        `${entry.before.blobId}.blob`,
        MAX_RECOVERY_FILE_BYTES + 1024,
      )
      let content: Buffer | undefined
      try {
        content = await protector.open(protectedBlob, {
          repositoryId,
          purpose: 'blob',
          objectId: `${safetyId}:${entry.before.blobId}`,
        })
        if (
          content.length !== entry.before.plaintextBytes ||
          hash(content) !== entry.before.contentHash
        )
          throw new Error('safety blob mismatch')
      } finally {
        protectedBlob.fill(0)
        content?.fill(0)
      }
    }
    let intent: SafetyManifest
    try {
      intent = await readSafetyIntent(stagingPath, safetyId, repositoryId, protector)
    } catch {
      throw new SafetyResidueError('Final Safety intent could not be authenticated')
    }
    if (JSON.stringify(intent) !== JSON.stringify(manifest))
      throw new SafetyResidueError('Final Safety intent differs from its manifest')
    await validateFinalSafetyRoot(
      root,
      manifest,
      protector,
      options.allowMissingProtection === true,
    )
    return manifest
  } finally {
    protectedManifest.fill(0)
    plaintext?.fill(0)
  }
}

export async function readSafetyIntent(
  stagingPath: string,
  safetyId: string,
  repositoryId: string,
  protector: ContentProtector,
): Promise<SafetyManifest> {
  const root = safetyRoot(stagingPath, safetyId)
  const protectedIntent = await readDirectoryBoundFile(
    root,
    'intent.protected',
    MAX_SAFETY_MANIFEST_BYTES,
  )
  let plaintext: Buffer | undefined
  try {
    plaintext = await protector.open(protectedIntent, {
      repositoryId,
      purpose: 'manifest',
      objectId: `${safetyId}:intent`,
    })
    const manifest = parseSafetyManifest(JSON.parse(plaintext.toString('utf8')))
    if (manifest.repositoryId !== repositoryId || manifest.safetyId !== safetyId)
      throw new Error('safety intent binding mismatch')
    return manifest
  } finally {
    protectedIntent.fill(0)
    plaintext?.fill(0)
  }
}

function leaseIdentityMatches(actual: PathIdentity | null, expected: PathIdentity): boolean {
  return Boolean(
    actual &&
      actual.device === expected.device &&
      actual.inode === expected.inode &&
      actual.type === expected.type &&
      actual.size === expected.size &&
      actual.modifiedAtNs === expected.modifiedAtNs &&
      actual.changedAtNs === expected.changedAtNs,
  )
}

function heldIdentityMatches(actual: BigIntStats, expected: PathIdentity): boolean {
  return (
    actual.dev === expected.device &&
    actual.ino === expected.inode &&
    (actual.isFile() ? 'file' : actual.isDirectory() ? 'directory' : 'other') === expected.type &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.modifiedAtNs &&
    actual.ctimeNs === expected.changedAtNs
  )
}

const MAX_SAFETY_LEASE_BYTES = Math.max(MAX_SAFETY_MANIFEST_BYTES, MAX_RECOVERY_FILE_BYTES + 1024)

async function verifyLeaseRoot(lease: SafetyLease): Promise<void> {
  if (!leaseIdentityMatches(await lstatIdentity(lease.rootPath), lease.rootIdentity))
    throw new SafetyResidueError('Held Safety root identity changed')
  if (!heldIdentityMatches(await lease.rootHandle.stat({ bigint: true }), lease.rootIdentity))
    throw new SafetyResidueError('Held Safety root descriptor changed')
}

async function verifyLeaseArtifact(
  lease: SafetyLease,
  artifact: SafetyLeaseArtifact,
  heldHandle?: FileHandle,
): Promise<void> {
  const path = join(lease.rootPath, artifact.name)
  if (!leaseIdentityMatches(await lstatIdentity(path), artifact.identity))
    throw new SafetyResidueError('Safety lease artifact identity changed')
  const handle = heldHandle ?? (await open(path, constants.O_RDONLY | constants.O_NOFOLLOW))
  try {
    if (!heldIdentityMatches(await handle.stat({ bigint: true }), artifact.identity))
      throw new SafetyResidueError('Held Safety artifact changed')
    const content = heldHandle
      ? await readDirectoryBoundFile(lease.rootPath, artifact.name, MAX_SAFETY_LEASE_BYTES)
      : await handle.readFile()
    try {
      if (artifact.name.endsWith('.blob')) safetyLeaseMetrics.blobByteReads++
      else safetyLeaseMetrics.controlByteReads++
      if (content.length > MAX_SAFETY_LEASE_BYTES || hash(content) !== artifact.protectedHash)
        throw new SafetyResidueError('Safety lease artifact content changed')
    } finally {
      content.fill(0)
    }
    if (
      !leaseIdentityMatches(await lstatIdentity(path), artifact.identity) ||
      !heldIdentityMatches(await handle.stat({ bigint: true }), artifact.identity)
    )
      throw new SafetyResidueError('Safety lease artifact changed during validation')
  } finally {
    if (!heldHandle) await handle.close().catch(() => undefined)
  }
}

async function verifyLeaseControlIdentity(
  lease: SafetyLease,
  control: SafetyLeaseControl,
): Promise<void> {
  if (
    !leaseIdentityMatches(
      await lstatIdentity(join(lease.rootPath, control.name)),
      control.identity,
    ) ||
    !heldIdentityMatches(await control.handle.stat({ bigint: true }), control.identity)
  )
    throw new SafetyResidueError('Safety lease control identity changed')
}

async function validateRawSafetyLease(lease: SafetyLease): Promise<void> {
  await verifyLeaseRoot(lease)
  const expectedNames = new Set(lease.artifacts.map((artifact) => artifact.name))
  const directory = await opendir(lease.rootPath)
  const actualNames = new Set<string>()
  try {
    for await (const entry of directory) {
      if (!entry.isFile() || entry.isSymbolicLink() || !expectedNames.has(entry.name))
        throw new SafetyResidueError('Safety lease child set changed')
      actualNames.add(entry.name)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  if (
    actualNames.size !== expectedNames.size ||
    [...expectedNames].some((name) => !actualNames.has(name))
  )
    throw new SafetyResidueError('Safety lease child set changed')
  const controlByName = new Map(lease.controls.map((control) => [control.name, control]))
  for (const artifact of lease.artifacts)
    await verifyLeaseArtifact(lease, artifact, controlByName.get(artifact.name)?.handle)
}

export async function acquireSafetyLease(
  stagingPath: string,
  manifest: SafetyManifest,
  protector: ContentProtector,
): Promise<SafetyLease> {
  const rootPath = safetyRoot(stagingPath, manifest.safetyId)
  const rootIdentity = await assertSafeDirectory(rootPath)
  const handles: FileHandle[] = []
  try {
    const rootHandle = await open(
      rootPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    handles.push(rootHandle)
    const directory = await opendir(rootPath)
    const names: string[] = []
    try {
      for await (const entry of directory) names.push(entry.name)
    } finally {
      await directory.close().catch(() => undefined)
    }
    names.sort()
    const artifacts: SafetyLeaseArtifact[] = []
    for (const name of names) {
      const identity = await lstatIdentity(join(rootPath, name))
      if (!identity || identity.type !== 'file')
        throw new SafetyResidueError('Safety lease contains a non-file artifact')
      const content = await readDirectoryBoundFile(rootPath, name, MAX_SAFETY_LEASE_BYTES)
      try {
        if (name.endsWith('.blob')) safetyLeaseMetrics.blobByteReads++
        else safetyLeaseMetrics.controlByteReads++
        artifacts.push({ name, identity, protectedHash: hash(content) })
      } finally {
        content.fill(0)
      }
    }
    const artifactByName = new Map(artifacts.map((artifact) => [artifact.name, artifact]))
    const controls: SafetyLeaseControl[] = []
    for (const name of ['intent.protected', 'manifest.protected', 'protection.json']) {
      const artifact = artifactByName.get(name)
      if (!artifact) throw new SafetyResidueError('Safety lease is missing a control artifact')
      const handle = await open(join(rootPath, name), constants.O_RDONLY | constants.O_NOFOLLOW)
      handles.push(handle)
      controls.push({ ...artifact, handle })
    }
    const lease: SafetyLease = {
      rootPath,
      rootIdentity,
      rootHandle,
      manifestFingerprint: hash(JSON.stringify(manifest)),
      artifacts,
      artifactByName,
      controls,
      blobByEntryId: new Map(
        manifest.entries.flatMap((entry) =>
          entry.before.state === 'present' && entry.before.type === 'file'
            ? [[entry.entryId, `${entry.before.blobId}.blob`] as const]
            : [],
        ),
      ),
      heldDescriptorCount: handles.length,
      closed: false,
    }
    const authenticated = await readSafetyPoint(
      stagingPath,
      manifest.safetyId,
      manifest.repositoryId,
      protector,
    )
    if (JSON.stringify(authenticated) !== JSON.stringify(manifest))
      throw new SafetyResidueError('Safety changed before lease acquisition')
    await validateRawSafetyLease(lease)
    safetyLeaseMetrics.currentHeldDescriptors += lease.heldDescriptorCount
    safetyLeaseMetrics.peakHeldDescriptors = Math.max(
      safetyLeaseMetrics.peakHeldDescriptors,
      safetyLeaseMetrics.currentHeldDescriptors,
    )
    return lease
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)))
    throw error
  }
}

export async function assertSafetyLease(
  lease: SafetyLease,
  manifest: SafetyManifest,
  protector: ContentProtector,
): Promise<void> {
  try {
    safetyLeaseMetrics.fullValidations++
    await validateRawSafetyLease(lease)
    const authenticated = await readSafetyPoint(
      resolve(lease.rootPath, '../../..'),
      manifest.safetyId,
      manifest.repositoryId,
      protector,
    )
    if (
      hash(JSON.stringify(authenticated)) !== lease.manifestFingerprint ||
      JSON.stringify(authenticated) !== JSON.stringify(manifest)
    )
      throw new SafetyResidueError('Authenticated Safety changed during apply')
    await validateRawSafetyLease(lease)
  } catch (error) {
    if (error instanceof SafetyResidueError) throw error
    throw new SafetyResidueError('Safety lease could not be revalidated')
  }
}

export async function assertSafetyLeaseEntry(lease: SafetyLease, entryId: string): Promise<void> {
  try {
    safetyLeaseMetrics.entryValidations++
    await verifyLeaseRoot(lease)
    for (const control of lease.controls) await verifyLeaseControlIdentity(lease, control)
    const blobName = lease.blobByEntryId.get(entryId)
    if (!blobName) return
    safetyLeaseMetrics.artifactLookups++
    const blob = lease.artifactByName.get(blobName)
    if (!blob) throw new SafetyResidueError('Safety lease blob mapping is incomplete')
    await verifyLeaseArtifact(lease, blob)
  } catch (error) {
    if (error instanceof SafetyResidueError) throw error
    throw new SafetyResidueError('Safety lease entry could not be revalidated')
  }
}

export async function closeSafetyLease(lease: SafetyLease): Promise<void> {
  if (lease.closed) return
  lease.closed = true
  await Promise.all([
    ...lease.controls.map((control) => control.handle.close().catch(() => undefined)),
    lease.rootHandle.close().catch(() => undefined),
  ])
  safetyLeaseMetrics.currentHeldDescriptors -= lease.heldDescriptorCount
}

async function assertIntentFilesystem(
  manifest: SafetyManifest,
  metadata?: MetadataOptions,
): Promise<void> {
  for (const entry of manifest.entries) {
    const external = await assertSafeDirectory(entry.externalParent.path)
    if (
      external.device.toString() !== entry.externalParent.device ||
      external.inode.toString() !== entry.externalParent.inode
    )
      throw new SafetyResidueError('Safety intent mapping parent changed')
    const current = await lstatIdentity(entry.targetPath)
    if (entry.before.state === 'absent') {
      if (current) throw new SafetyResidueError('Safety intent absent target appeared')
      continue
    }
    if (
      !current ||
      current.type !== entry.before.type ||
      current.device.toString() !== entry.before.device ||
      current.inode.toString() !== entry.before.inode
    )
      throw new SafetyResidueError('Safety intent target identity changed')
    if (entry.before.type === 'file') {
      let content: Buffer
      try {
        content = await readVerifiedFile(
          entry.targetPath,
          entry.before.plaintextBytes as number,
          entry.before.contentHash as string,
        )
      } catch {
        throw new SafetyResidueError('Safety intent file content changed')
      }
      content.fill(0)
      if (
        current.size !== BigInt(entry.before.metadata.size) ||
        current.modifiedAtNs !== BigInt(entry.before.metadata.modifiedAtNs) ||
        current.changedAtNs.toString() !== entry.before.changedAtNs ||
        JSON.stringify(
          await captureCurrentMetadata(entry.targetPath, entry.before.type, metadata),
        ) !== JSON.stringify(entry.before.metadata)
      )
        throw new SafetyResidueError('Safety intent file metadata changed during capture')
      continue
    }
    if (
      current.size !== BigInt(entry.before.metadata.size) ||
      current.modifiedAtNs !== BigInt(entry.before.metadata.modifiedAtNs) ||
      current.changedAtNs.toString() !== entry.before.changedAtNs ||
      JSON.stringify(
        await captureCurrentMetadata(entry.targetPath, entry.before.type, metadata),
      ) !== JSON.stringify(entry.before.metadata)
    )
      throw new SafetyResidueError('Safety intent non-file metadata changed')
    if (
      entry.before.type === 'symlink' &&
      (await readLinkSafely(entry.targetPath)) !== entry.before.linkTarget
    )
      throw new SafetyResidueError('Safety intent symbolic link changed')
  }
}

export async function assertSafetyResumeExpectations(
  manifest: SafetyManifest,
  metadata?: MetadataOptions,
): Promise<void> {
  await assertIntentFilesystem(manifest, metadata)
}

async function assertIntentChildren(
  root: string,
  manifest: SafetyManifest,
  requireComplete = false,
): Promise<void> {
  const expected = new Set([
    'intent.protected',
    ...manifest.entries
      .filter((entry) => entry.before.state === 'present' && entry.before.type === 'file')
      .map((entry) => `${(entry.before as { blobId: string }).blobId}.blob`),
  ])
  const directory = await opendir(root)
  const actual = new Set<string>()
  try {
    for await (const entry of directory) {
      if (!entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name))
        throw new SafetyResidueError('Unexpected Safety intent residue blocks recovery')
      actual.add(entry.name)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  if (!actual.has('intent.protected') || (requireComplete && actual.size !== expected.size))
    throw new SafetyResidueError('Incomplete Safety intent residue blocks recovery')
}

async function assertEmptySafetyRoot(root: string): Promise<void> {
  const directory = await opendir(root)
  try {
    for await (const _entry of directory)
      throw new SafetyResidueError('Unexpected Safety residue blocks recovery')
  } finally {
    await directory.close().catch(() => undefined)
  }
}

function assertSafetyBinding(
  manifest: SafetyManifest,
  input: {
    stagingPath: string
    staging: StagingDescriptor
    safetyId: string
    applyId: string
    planFingerprint: string
    planItems: SafetyPlanItem[]
  },
): void {
  if (
    manifest.planFingerprint !== input.planFingerprint ||
    manifest.safetyId !== input.safetyId ||
    manifest.applyId !== input.applyId ||
    manifest.repositoryId !== input.staging.repositoryId ||
    manifest.protection !== input.staging.protection ||
    manifest.pointId !== input.staging.pointId ||
    manifest.stagingId !== input.staging.stagingId ||
    JSON.stringify(manifest.planItems) !== JSON.stringify(input.planItems) ||
    manifest.stagingPathFingerprint !== hash(resolve(input.stagingPath))
  )
    throw new SafetyResidueError('Safety intent does not match the reviewed apply')
}

export async function readSafetyBlob(
  stagingPath: string,
  manifest: SafetyManifest,
  entry: SafetyEntry,
  protector: ContentProtector,
): Promise<Buffer> {
  if (
    entry.before.state !== 'present' ||
    entry.before.type !== 'file' ||
    !entry.before.blobId ||
    entry.before.plaintextBytes === undefined ||
    !entry.before.contentHash
  )
    throw new Error('safety entry has no file')
  const root = safetyRoot(stagingPath, manifest.safetyId)
  const protectedBlob = await readDirectoryBoundFile(
    root,
    `${entry.before.blobId}.blob`,
    MAX_RECOVERY_FILE_BYTES + 1024,
  )
  try {
    const content = await protector.open(protectedBlob, {
      repositoryId: manifest.repositoryId,
      purpose: 'blob',
      objectId: `${manifest.safetyId}:${entry.before.blobId}`,
    })
    if (
      content.length !== entry.before.plaintextBytes ||
      hash(content) !== entry.before.contentHash
    ) {
      content.fill(0)
      throw new Error('safety content mismatch')
    }
    return content
  } finally {
    protectedBlob.fill(0)
  }
}

export async function createSafetyPoint(input: {
  stagingPath: string
  staging: StagingDescriptor
  safetyId: string
  applyId: string
  planFingerprint: string
  planItems: SafetyPlanItem[]
  items: SafetyCaptureItem[]
  protector: ContentProtector
  now: Date
  metadata?: MetadataOptions
  beforePublish?: () => void | Promise<void>
  afterManifestPublish?: () => void | Promise<void>
  allowIntentResume: boolean
}): Promise<SafetyManifest> {
  await mkdirUnderRoot(input.stagingPath, '.restore-control')
  await mkdirUnderRoot(input.stagingPath, '.restore-control/safety')
  const safetyDirectory = await opendir(join(input.stagingPath, '.restore-control', 'safety'))
  let safetyCount = 0
  try {
    for await (const entry of safetyDirectory) {
      if (++safetyCount > 1000) throw new SafetyResidueError('Too many Safety attempts exist')
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new SafetyResidueError('Invalid Safety residue blocks a new apply')
      if (entry.name === input.safetyId) continue
      const otherRoot = safetyRoot(input.stagingPath, entry.name)
      if (!(await lstatIdentity(join(otherRoot, 'manifest.protected'))))
        throw new SafetyResidueError('An incomplete prior Safety attempt blocks a new apply')
      const manifest = await readSafetyPoint(
        input.stagingPath,
        entry.name,
        input.staging.repositoryId,
        input.protector,
      )
      if (!(await safetyReleased(input.stagingPath, manifest, input.protector)))
        throw new SafetyResidueError('An active prior Safety Point blocks a different apply')
    }
  } finally {
    await safetyDirectory.close().catch(() => undefined)
  }
  await mkdirUnderRoot(input.stagingPath, `.restore-control/safety/${input.safetyId}`)
  const root = safetyRoot(input.stagingPath, input.safetyId)
  let manifest: SafetyManifest
  if (await lstatIdentity(join(root, 'manifest.protected'))) {
    manifest = await readSafetyPoint(
      input.stagingPath,
      input.safetyId,
      input.staging.repositoryId,
      input.protector,
      { allowMissingProtection: input.allowIntentResume },
    )
    assertSafetyBinding(manifest, input)
  } else {
    const intentPath = join(root, 'intent.protected')
    if (await lstatIdentity(intentPath)) {
      if (!input.allowIntentResume)
        throw new SafetyResidueError(
          'An incomplete Safety intent requires its original reviewed apply ID',
        )
      try {
        manifest = await readSafetyIntent(
          input.stagingPath,
          input.safetyId,
          input.staging.repositoryId,
          input.protector,
        )
      } catch {
        throw new SafetyResidueError('Safety intent could not be authenticated')
      }
      assertSafetyBinding(manifest, input)
      await assertIntentChildren(root, manifest)
      await assertIntentFilesystem(manifest, input.metadata)
    } else {
      await assertEmptySafetyRoot(root)
      const entries: SafetyEntry[] = []
      for (const item of input.items) entries.push(await captureEntry(item, input.metadata))
      const hardlinkAnchors = new Map<string, string>()
      for (const entry of entries) {
        if (entry.before.state !== 'present' || entry.before.type !== 'file') continue
        const key = `${entry.before.device}:${entry.before.inode}`
        const anchor = hardlinkAnchors.get(key)
        if (anchor) entry.before.hardlinkToEntryId = anchor
        else hardlinkAnchors.set(key, entry.entryId)
      }
      manifest = {
        formatVersion: 1,
        kind: 'restore-safety-point',
        safetyId: input.safetyId,
        applyId: input.applyId,
        repositoryId: input.staging.repositoryId,
        protection: input.staging.protection,
        pointId: input.staging.pointId,
        stagingId: input.staging.stagingId,
        stagingPathFingerprint: hash(resolve(input.stagingPath)),
        planFingerprint: input.planFingerprint,
        createdAt: input.now.toISOString(),
        planItems: input.planItems,
        entries,
      }
      await assertIntentFilesystem(manifest, input.metadata)
      const protectedIntent = await input.protector.seal(Buffer.from(JSON.stringify(manifest)), {
        repositoryId: input.staging.repositoryId,
        purpose: 'manifest',
        objectId: `${input.safetyId}:intent`,
      })
      try {
        await writeProtected(root, 'intent.protected', protectedIntent)
      } finally {
        protectedIntent.fill(0)
      }
    }
    for (const entry of manifest.entries) {
      if (entry.before.state !== 'present' || entry.before.type !== 'file') continue
      const content = await readVerifiedFile(
        entry.targetPath,
        entry.before.plaintextBytes as number,
        entry.before.contentHash as string,
      )
      try {
        await writeOrVerifyProtectedBlob({
          directory: root,
          name: `${entry.before.blobId}.blob`,
          plaintext: content,
          protector: input.protector,
          repositoryId: input.staging.repositoryId,
          objectId: `${input.safetyId}:${entry.before.blobId}`,
        })
      } finally {
        content.fill(0)
      }
    }
    await assertIntentChildren(root, manifest, true)
    await assertIntentFilesystem(manifest, input.metadata)
    const protectedManifest = await input.protector.seal(Buffer.from(JSON.stringify(manifest)), {
      repositoryId: input.staging.repositoryId,
      purpose: 'manifest',
      objectId: input.safetyId,
    })
    try {
      await input.beforePublish?.()
      await writeProtected(root, 'manifest.protected', protectedManifest)
    } finally {
      protectedManifest.fill(0)
    }
    await input.afterManifestPublish?.()
  }
  const protection: SafetyProtectionDescriptor = {
    formatVersion: 1,
    kind: 'restore-safety-protection',
    safetyId: input.safetyId,
    repositoryId: input.staging.repositoryId,
    pointId: input.staging.pointId,
    stagingId: input.staging.stagingId,
    planFingerprint: input.planFingerprint,
    active: true,
    createdAt: manifest.createdAt,
  }
  await writeProtected(root, 'protection.json', Buffer.from(`${JSON.stringify(protection)}\n`))
  return readSafetyPoint(
    input.stagingPath,
    input.safetyId,
    input.staging.repositoryId,
    input.protector,
  )
}

export async function assertSafetyPointExpectations(manifest: SafetyManifest): Promise<void> {
  for (const entry of manifest.entries) {
    const externalParent = await assertSafeDirectory(entry.externalParent.path)
    if (
      externalParent.device.toString() !== entry.externalParent.device ||
      externalParent.inode.toString() !== entry.externalParent.inode
    )
      throw new Error('safety mapping parent changed before apply')
    const current = await lstatIdentity(entry.targetPath)
    if (entry.before.state === 'absent') {
      if (current) throw new Error('safety target appeared before apply')
      continue
    }
    if (
      !current ||
      current.type !== entry.before.type ||
      current.device.toString() !== entry.before.device ||
      current.inode.toString() !== entry.before.inode ||
      current.size !== BigInt(entry.before.metadata.size) ||
      current.modifiedAtNs !== BigInt(entry.before.metadata.modifiedAtNs) ||
      current.changedAtNs.toString() !== entry.before.changedAtNs
    )
      throw new Error('safety target changed before apply')
  }
}

export async function deactivateSafetyProtection(input: {
  stagingPath: string
  manifest: SafetyManifest
  protector: ContentProtector
  reason: 'post-apply-verified' | 'rollback-verified'
  now: Date
}): Promise<void> {
  if (await safetyReleased(input.stagingPath, input.manifest, input.protector)) return
  const release = {
    formatVersion: 1,
    kind: 'restore-safety-release',
    safetyId: input.manifest.safetyId,
    repositoryId: input.manifest.repositoryId,
    pointId: input.manifest.pointId,
    planFingerprint: input.manifest.planFingerprint,
    reason: input.reason,
    releasedAt: input.now.toISOString(),
  }
  const protectedRelease = await input.protector.seal(Buffer.from(JSON.stringify(release)), {
    repositoryId: input.manifest.repositoryId,
    purpose: 'manifest',
    objectId: `${input.manifest.safetyId}:release`,
  })
  try {
    await writeProtected(
      safetyRoot(input.stagingPath, input.manifest.safetyId),
      'release.protected',
      protectedRelease,
    )
  } finally {
    protectedRelease.fill(0)
  }
}

async function safetyReleased(
  stagingPath: string,
  manifest: SafetyManifest,
  protector: ContentProtector,
): Promise<boolean> {
  const root = safetyRoot(stagingPath, manifest.safetyId)
  return readValidSafetyRelease(root, manifest, protector)
}

export async function isRecoveryPointProtectedBySafety(
  stagingPath: string,
  pointId: string,
  repositoryId: string,
  protector: ContentProtector,
  dependencies: { openDirectory?: typeof opendir } = {},
): Promise<boolean> {
  const root = join(stagingPath, '.restore-control', 'safety')
  let directory: Awaited<ReturnType<typeof opendir>>
  try {
    directory = await (dependencies.openDirectory ?? opendir)(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  let count = 0
  try {
    for await (const entry of directory) {
      if (++count > 1000) throw new Error('too many safety points')
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error('invalid safety protection entry')
      const manifest = await readSafetyPoint(stagingPath, entry.name, repositoryId, protector)
      if (manifest.pointId === pointId && !(await safetyReleased(stagingPath, manifest, protector)))
        return true
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  return false
}

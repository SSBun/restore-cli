import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCapturePlan } from '../../src/catalog/index.js'
import { sourceContractFingerprint } from '../../src/catalog/scope.js'
import { createV1RecoveryPoint } from '../../src/engine/v1-backup.js'
import type { PluginManifest } from '../../src/plugin/types.js'
import type { CredentialProvider } from '../../src/protection/credentials.js'
import { MasterKey } from '../../src/protection/secrets.js'
import { initializeRepository, openRepository } from '../../src/repository/index.js'
import {
  MAX_PROTECTED_BLOB_BYTES,
  MAX_PROTECTED_MANIFEST_BYTES,
  verifyV1Repository,
} from '../../src/verify/index.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

class MemoryCredentials implements CredentialProvider {
  readonly keys = new Map<string, Buffer>()
  async storeMasterKey(repositoryId: string, masterKey: MasterKey): Promise<void> {
    this.keys.set(repositoryId, masterKey.copyBytes())
  }
  async loadMasterKey(repositoryId: string): Promise<MasterKey> {
    const value = this.keys.get(repositoryId)
    if (!value) throw new Error('missing key')
    return new MasterKey(value)
  }
  async deleteMasterKey(repositoryId: string): Promise<void> {
    this.keys.delete(repositoryId)
  }
}

async function fixture(protection: 'plaintext' | 'encrypted' = 'plaintext') {
  const root = await mkdtemp(join(tmpdir(), 'restore-verify-'))
  roots.push(root)
  const credentials = protection === 'encrypted' ? new MemoryCredentials() : undefined
  const initialized = await initializeRepository({
    targetPath: root,
    protection,
    ...(credentials
      ? {
          credentialProvider: credentials,
          exportRecoveryCredential: async (material: string) => material,
        }
      : {}),
  })
  const source = join(root, 'source')
  await writeFile(source, 'verified content')
  const plugin: PluginManifest = {
    name: 'test',
    description: 'test',
    paths: [source],
    sources: [
      {
        name: 'source',
        path: source,
        requirement: 'required',
        sensitivity: 'private',
        expectedType: 'file',
        recoveryScope: 'exact',
      },
    ],
  }
  return { ...initialized, root, source, protection, credentials, plan: buildCapturePlan([plugin]) }
}

async function backup(
  repository: Awaited<ReturnType<typeof fixture>>,
  pointId: string,
  now = new Date('2026-07-19T00:00:00.000Z'),
) {
  return createV1RecoveryPoint({
    repositoryPath: repository.repositoryPath,
    expectedRepositoryId: repository.repositoryId,
    expectedProtection: repository.protection,
    ...(repository.credentials ? { credentialProvider: repository.credentials } : {}),
    plan: repository.plan,
    pointId,
    now: () => now,
  })
}

async function readManifestValue(
  repository: Awaited<ReturnType<typeof fixture>>,
  pointId: string,
): Promise<Record<string, unknown>> {
  const handle = await openRepository(repository.repositoryPath, {
    intent: 'read',
    expectedRepositoryId: repository.repositoryId,
    expectedProtection: repository.protection,
    ...(repository.credentials ? { credentialProvider: repository.credentials } : {}),
  })
  try {
    if (!handle.protector) throw new Error('missing protector')
    const name = repository.protection === 'encrypted' ? 'manifest.enc' : 'manifest.json'
    const protectedContent = await readFile(join(handle.layout.points, pointId, name))
    const plaintext = await handle.protector.open(protectedContent, {
      repositoryId: repository.repositoryId,
      purpose: 'manifest',
      objectId: pointId,
    })
    return JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>
  } finally {
    handle.close()
  }
}

async function rewriteManifest(
  repository: Awaited<ReturnType<typeof fixture>>,
  pointId: string,
  mutate: (value: Record<string, unknown>) => void,
): Promise<void> {
  const handle = await openRepository(repository.repositoryPath, {
    intent: 'read',
    expectedRepositoryId: repository.repositoryId,
    expectedProtection: repository.protection,
    ...(repository.credentials ? { credentialProvider: repository.credentials } : {}),
  })
  try {
    if (!handle.protector) throw new Error('missing protector')
    const name = repository.protection === 'encrypted' ? 'manifest.enc' : 'manifest.json'
    const path = join(handle.layout.points, pointId, name)
    const protectedContent = await readFile(path)
    const plaintext = await handle.protector.open(protectedContent, {
      repositoryId: repository.repositoryId,
      purpose: 'manifest',
      objectId: pointId,
    })
    const value = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>
    mutate(value)
    const replacement = await handle.protector.seal(Buffer.from(JSON.stringify(value)), {
      repositoryId: repository.repositoryId,
      purpose: 'manifest',
      objectId: pointId,
    })
    await writeFile(path, replacement)
  } finally {
    handle.close()
  }
}

async function blobPath(
  repository: Awaited<ReturnType<typeof fixture>>,
  pointId: string,
): Promise<string> {
  const manifest = await readManifestValue(repository, pointId)
  const blobs = manifest.blobs as Array<{ path: string }>
  return join(repository.repositoryPath, 'points', pointId, blobs[0].path)
}

async function treeDigest(path: string): Promise<string> {
  const rows: string[] = []
  async function walk(current: string, prefix = ''): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        rows.push(`d:${relative}`)
        await walk(full, relative)
      } else {
        rows.push(
          `f:${relative}:${createHash('sha256')
            .update(await readFile(full))
            .digest('hex')}`,
        )
      }
    }
  }
  await walk(path)
  return rows.join('\n')
}

function verifyOptions(repository: Awaited<ReturnType<typeof fixture>>) {
  return {
    repositoryPath: repository.repositoryPath,
    expectedRepositoryId: repository.repositoryId,
    expectedProtection: repository.protection,
    ...(repository.credentials ? { credentialProvider: repository.credentials } : {}),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v1 verification', () => {
  it('distinguishes structural and complete content coverage without writes', async () => {
    const repository = await fixture()
    await backup(repository, 'point-a')
    const before = await treeDigest(repository.repositoryPath)

    const structural = await verifyV1Repository({
      ...verifyOptions(repository),
      selector: { kind: 'latest' },
      scope: 'structural',
    })
    const content = await verifyV1Repository({
      ...verifyOptions(repository),
      selector: { kind: 'point', pointId: 'point-a' },
      scope: 'content',
    })

    expect(structural).toMatchObject({ state: 'success', resolvedPointId: 'point-a', cost: 'low' })
    expect(content).toMatchObject({ state: 'success', filesConsidered: 1, filesVerified: 1 })
    expect(content.bytesVerified).toBe(Buffer.byteLength('verified content'))
    expect(await treeDigest(repository.repositoryPath)).toBe(before)
  })

  it('detects content tampering and wrong encrypted credentials', async () => {
    const repository = await fixture('encrypted')
    await backup(repository, 'encrypted-point')
    const handle = await openRepository(repository.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: 'encrypted',
      credentialProvider: repository.credentials,
    })
    const manifestProtected = await readFile(
      join(handle.layout.points, 'encrypted-point', 'manifest.enc'),
    )
    const manifestPlaintext = await handle.protector?.open(manifestProtected, {
      repositoryId: repository.repositoryId,
      purpose: 'manifest',
      objectId: 'encrypted-point',
    })
    const manifest = JSON.parse(manifestPlaintext?.toString('utf8') ?? '{}') as {
      blobs: Array<{ path: string }>
    }
    handle.close()
    const blobPath = join(
      repository.repositoryPath,
      'points',
      'encrypted-point',
      manifest.blobs[0].path,
    )
    const content = await readFile(blobPath)
    content[content.length - 1] ^= 1
    await writeFile(blobPath, content)

    const tampered = await verifyV1Repository({
      ...verifyOptions(repository),
      selector: { kind: 'point', pointId: 'encrypted-point' },
      scope: 'content',
    })
    expect(tampered).toMatchObject({ state: 'failure', category: 'integrity' })

    const wrong = new MemoryCredentials()
    wrong.keys.set(repository.repositoryId, Buffer.alloc(32, 7))
    const wrongKey = await verifyV1Repository({
      ...verifyOptions(repository),
      credentialProvider: wrong,
      selector: { kind: 'latest' },
      scope: 'structural',
    })
    expect(wrongKey).toMatchObject({ state: 'failure', category: 'authentication' })
  })

  it('orders equal completion times by ID and reports malformed visible points for all', async () => {
    const repository = await fixture()
    await backup(repository, 'alpha')
    await backup(repository, 'zeta')
    await writeFile(join(repository.repositoryPath, 'points', 'broken'), 'not a directory')

    const latest = await verifyV1Repository({
      ...verifyOptions(repository),
      selector: { kind: 'latest' },
      scope: 'structural',
    })
    const all = await verifyV1Repository({
      ...verifyOptions(repository),
      selector: { kind: 'all' },
      scope: 'structural',
    })
    expect(latest.resolvedPointId).toBe('zeta')
    expect(all).toMatchObject({ state: 'failure', pointsConsidered: 3, pointsFailed: 1 })
  })

  it('rejects malformed, mismatched, and oversized public/protected metadata', async () => {
    const malformed = await fixture()
    await backup(malformed, 'malformed')
    await rewriteManifest(malformed, 'malformed', (value) => {
      value.unknownField = true
    })
    expect(
      await verifyV1Repository({
        ...verifyOptions(malformed),
        selector: { kind: 'point', pointId: 'malformed' },
        scope: 'structural',
      }),
    ).toMatchObject({ state: 'failure', category: 'integrity' })

    const oversizedDescriptor = await fixture()
    await backup(oversizedDescriptor, 'oversized-descriptor')
    const oversizedDescriptorPath = join(
      oversizedDescriptor.repositoryPath,
      'points',
      'oversized-descriptor',
      'point.json',
    )
    const descriptorFile = await open(oversizedDescriptorPath, 'w')
    await descriptorFile.truncate(64 * 1024 + 1)
    await descriptorFile.close()
    expect(
      await verifyV1Repository({
        ...verifyOptions(oversizedDescriptor),
        selector: { kind: 'point', pointId: 'oversized-descriptor' },
        scope: 'structural',
      }),
    ).toMatchObject({ state: 'failure', category: 'integrity' })

    const mismatch = await fixture()
    await backup(mismatch, 'mismatch')
    const descriptorPath = join(mismatch.repositoryPath, 'points', 'mismatch', 'point.json')
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<string, unknown>
    descriptor.pointId = 'different'
    await writeFile(descriptorPath, JSON.stringify(descriptor))
    expect(
      await verifyV1Repository({
        ...verifyOptions(mismatch),
        selector: { kind: 'point', pointId: 'mismatch' },
        scope: 'structural',
      }),
    ).toMatchObject({ state: 'failure', category: 'integrity' })

    const oversized = await fixture()
    await backup(oversized, 'oversized')
    const manifestPath = join(oversized.repositoryPath, 'points', 'oversized', 'manifest.json')
    const file = await open(manifestPath, 'w')
    await file.truncate(MAX_PROTECTED_MANIFEST_BYTES + 1)
    await file.close()
    expect(
      await verifyV1Repository({
        ...verifyOptions(oversized),
        selector: { kind: 'point', pointId: 'oversized' },
        scope: 'structural',
      }),
    ).toMatchObject({ state: 'failure', category: 'integrity' })
  })

  it('rejects stale plaintext secret acceptance fingerprints', async () => {
    const repository = await fixture()
    await backup(repository, 'stale-acceptance')
    await rewriteManifest(repository, 'stale-acceptance', (value) => {
      const sources = value.sources as Array<Record<string, unknown>>
      sources[0].sensitivity = 'secret'
      value.plaintextSecretAcceptances = [
        {
          repositoryId: repository.repositoryId,
          sourceId: sources[0].id,
          sourceContractFingerprint: '0'.repeat(64),
          acceptedAt: '2026-01-01T00:00:00.000Z',
        },
      ]
    })
    const result = await verifyV1Repository({
      ...verifyOptions(repository),
      selector: { kind: 'point', pointId: 'stale-acceptance' },
      scope: 'structural',
    })
    expect(result).toMatchObject({ state: 'failure', category: 'integrity' })
    expect(result.issues.map((entry) => entry.code)).toContain('INVALID_POINT_REFERENCES')
  })

  it('rejects future plaintext secret acceptance with the exact source fingerprint', async () => {
    const repository = await fixture()
    await backup(repository, 'future-acceptance')
    await rewriteManifest(repository, 'future-acceptance', (value) => {
      const sources = value.sources as Array<Record<string, unknown>>
      const source = sources[0]
      source.sensitivity = 'secret'
      value.plaintextSecretAcceptances = [
        {
          repositoryId: repository.repositoryId,
          sourceId: source.id,
          sourceContractFingerprint: sourceContractFingerprint({
            id: String(source.id),
            plugin: String(source.plugin),
            name: String(source.name),
            declaredPath: String(source.declaredPath),
            path: String(source.resolvedPath),
            requirement: source.requirement as 'required' | 'optional',
            sensitivity: 'secret',
            expectedType: source.expectedType as 'file' | 'directory' | 'symlink' | 'any',
            recoveryScope: String(source.recoveryScope),
            ...(source.consistencyGroup
              ? { consistencyGroup: String(source.consistencyGroup) }
              : {}),
            includeEmptyDirectories: Boolean(source.includeEmptyDirectories),
          }),
          acceptedAt: '2026-07-20T00:00:00.000Z',
        },
      ]
    })
    const result = await verifyV1Repository({
      ...verifyOptions(repository),
      selector: { kind: 'point', pointId: 'future-acceptance' },
      scope: 'structural',
    })
    expect(result).toMatchObject({ state: 'failure', category: 'integrity', complete: false })
    expect(result.issues.map((entry) => entry.code)).toContain('INVALID_POINT_REFERENCES')
  })

  it('never reports complete coverage when no recovery point was considered', async () => {
    const empty = await fixture()
    const encrypted = await fixture('encrypted')
    const reports = [
      await verifyV1Repository({
        ...verifyOptions(empty),
        selector: { kind: 'latest' },
        scope: 'structural',
      }),
      await verifyV1Repository({
        ...verifyOptions(empty),
        selector: { kind: 'point', pointId: 'missing' },
        scope: 'structural',
      }),
      await verifyV1Repository({
        repositoryPath: encrypted.repositoryPath,
        expectedRepositoryId: encrypted.repositoryId,
        expectedProtection: 'encrypted',
        selector: { kind: 'all' },
        scope: 'structural',
      }),
    ]
    for (const report of reports) {
      expect(report).toMatchObject({ state: 'failure', pointsConsidered: 0, complete: false })
      expect(report.coverage.complete).toBe(false)
    }
  })

  it('rejects duplicate xattr names and flags independently', async () => {
    for (const kind of ['xattrs', 'flags'] as const) {
      const repository = await fixture()
      await backup(repository, `duplicate-${kind}`)
      await rewriteManifest(repository, `duplicate-${kind}`, (value) => {
        const entries = value.entries as Array<{
          metadata: Record<string, unknown>
        }>
        if (kind === 'xattrs') {
          entries[0].metadata.xattrs = [
            { name: 'duplicate', value: '' },
            { name: 'duplicate', value: '' },
          ]
        } else entries[0].metadata.flags = ['hidden', 'hidden']
      })
      const result = await verifyV1Repository({
        ...verifyOptions(repository),
        selector: { kind: 'point', pointId: `duplicate-${kind}` },
        scope: 'structural',
      })
      expect(result, kind).toMatchObject({ state: 'failure', category: 'integrity' })
      expect(result.issues.map((entry) => entry.code)).toContain('DUPLICATE_ENTRY_METADATA')
    }
  })

  it('rejects missing, symlink, FIFO, and oversized blob objects structurally', async () => {
    for (const kind of ['missing', 'symlink', 'fifo', 'oversize'] as const) {
      const repository = await fixture()
      await backup(repository, kind)
      const path = await blobPath(repository, kind)
      await unlink(path)
      if (kind === 'symlink') {
        const outside = join(repository.root, 'outside')
        await writeFile(outside, 'outside')
        await symlink(outside, path)
      } else if (kind === 'fifo') {
        await execFileAsync('/usr/bin/mkfifo', [path])
      } else if (kind === 'oversize') {
        const file = await open(path, 'w')
        await file.truncate(MAX_PROTECTED_BLOB_BYTES + 1)
        await file.close()
      }
      const result = await verifyV1Repository({
        ...verifyOptions(repository),
        selector: { kind: 'point', pointId: kind },
        scope: 'structural',
      })
      expect(result, kind).toMatchObject({ state: 'failure', category: 'integrity' })
    }
  })

  it('classifies encrypted manifest tamper as integrity after credential authentication', async () => {
    const repository = await fixture('encrypted')
    await backup(repository, 'manifest-tamper')
    const path = join(repository.repositoryPath, 'points', 'manifest-tamper', 'manifest.enc')
    const content = await readFile(path)
    content[content.length - 1] ^= 1
    await writeFile(path, content)
    const result = await verifyV1Repository({
      ...verifyOptions(repository),
      selector: { kind: 'point', pointId: 'manifest-tamper' },
      scope: 'structural',
    })
    expect(result).toMatchObject({ state: 'failure', category: 'integrity' })
    expect(result.issues.map((entry) => entry.code)).toContain('MANIFEST_AUTHENTICATION_FAILED')
  })

  it('detects plaintext blob hash and length mismatches only when content is read', async () => {
    for (const kind of ['hash', 'length'] as const) {
      const repository = await fixture()
      await backup(repository, kind)
      const path = await blobPath(repository, kind)
      const protectedContent = await readFile(path)
      if (kind === 'hash') {
        protectedContent[protectedContent.length - 1] ^= 1
        await writeFile(path, protectedContent)
      } else {
        await writeFile(path, Buffer.concat([protectedContent, Buffer.from('x')]))
        await rewriteManifest(repository, kind, (value) => {
          const blobs = value.blobs as Array<Record<string, unknown>>
          blobs[0].protectedBytes = protectedContent.length + 1
        })
      }
      const structural = await verifyV1Repository({
        ...verifyOptions(repository),
        selector: { kind: 'point', pointId: kind },
        scope: 'structural',
      })
      const content = await verifyV1Repository({
        ...verifyOptions(repository),
        selector: { kind: 'point', pointId: kind },
        scope: 'content',
      })
      expect(structural, kind).toMatchObject({ state: 'success' })
      expect(content, kind).toMatchObject({ state: 'failure', category: 'integrity' })
    }
  })

  it('excludes partial latest points and reports mixed repository coverage', async () => {
    const repository = await fixture()
    await backup(repository, 'older-healthy', new Date('2026-01-01T00:00:00.000Z'))
    await backup(repository, 'newer-partial', new Date('2026-01-02T00:00:00.000Z'))
    await rewriteManifest(repository, 'newer-partial', (value) => {
      value.health = 'partial'
    })
    await writeFile(join(repository.repositoryPath, 'points', 'malformed'), 'not a point')
    const selected = await verifyV1Repository({
      ...verifyOptions(repository),
      selector: { kind: 'latest-healthy' },
      scope: 'structural',
    })
    const all = await verifyV1Repository({
      ...verifyOptions(repository),
      selector: { kind: 'all' },
      scope: 'content',
    })
    expect(selected.resolvedPointId).toBe('older-healthy')
    expect(all).toMatchObject({
      state: 'failure',
      pointsConsidered: 3,
      pointsVerified: 2,
      pointsFailed: 1,
      filesConsidered: 2,
      filesVerified: 2,
      complete: false,
    })
  })
})

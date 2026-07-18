import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capturePlan as captureResolvedPlan } from '../../src/catalog/capture.js'
import { buildCapturePlan } from '../../src/catalog/index.js'
import { sourceContractFingerprint } from '../../src/catalog/scope.js'
import type { PlaintextSecretAcceptance } from '../../src/config/types.js'
import {
  type BackupWriteStage,
  type RecoveryPointManifestV1,
  type V1CapturedMetadataOverride,
  createV1RecoveryPoint,
} from '../../src/engine/v1-backup.js'
import type { PluginManifest, SourceSpec } from '../../src/plugin/types.js'
import type { CredentialProvider } from '../../src/protection/credentials.js'
import { MasterKey } from '../../src/protection/secrets.js'
import {
  acquireRepositoryLock,
  initializeRepository,
  inspectRepositoryLock,
  openRepository,
} from '../../src/repository/index.js'
import type { ProtectionMode, RepositoryLock } from '../../src/repository/index.js'

const roots: string[] = []
const fixedNow = () => new Date('2026-07-19T00:00:00.000Z')

class MemoryCredentials implements CredentialProvider {
  readonly keys = new Map<string, Buffer>()

  async storeMasterKey(repositoryId: string, masterKey: MasterKey): Promise<void> {
    this.keys.set(repositoryId, masterKey.copyBytes())
  }

  async loadMasterKey(repositoryId: string): Promise<MasterKey> {
    const key = this.keys.get(repositoryId)
    if (!key) throw new Error('missing key')
    return new MasterKey(key)
  }

  async deleteMasterKey(repositoryId: string): Promise<void> {
    this.keys.delete(repositoryId)
  }
}

interface TestRepository {
  root: string
  repositoryPath: string
  repositoryId: string
  protection: ProtectionMode
  credentials?: MemoryCredentials
}

async function createRepository(protection: ProtectionMode = 'plaintext'): Promise<TestRepository> {
  const root = await mkdtemp(join(tmpdir(), 'restore-v1-backup-'))
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
  return {
    root,
    repositoryPath: initialized.repositoryPath,
    repositoryId: initialized.repositoryId,
    protection,
    ...(credentials ? { credentials } : {}),
  }
}

function sourcePlugin(path: string, source: Partial<SourceSpec> = {}): PluginManifest {
  const spec: SourceSpec = {
    name: source.name ?? 'source',
    path,
    requirement: source.requirement ?? 'required',
    sensitivity: source.sensitivity ?? 'private',
    expectedType: source.expectedType ?? 'file',
    recoveryScope: source.recoveryScope ?? 'exact',
    ...(source.consistencyGroup ? { consistencyGroup: source.consistencyGroup } : {}),
  }
  return { name: source.name ?? 'plugin', description: 'test', paths: [path], sources: [spec] }
}

function backupOptions(repository: TestRepository, plugins: PluginManifest[], pointId: string) {
  return {
    repositoryPath: repository.repositoryPath,
    expectedRepositoryId: repository.repositoryId,
    expectedProtection: repository.protection,
    ...(repository.credentials ? { credentialProvider: repository.credentials } : {}),
    plan: buildCapturePlan(plugins),
    pointId,
    now: fixedNow,
  }
}

async function pointNames(repository: TestRepository): Promise<string[]> {
  return (await readdir(join(repository.repositoryPath, 'points'))).sort()
}

async function corruptLockOwner(repository: TestRepository): Promise<void> {
  const ownerPath = join(repository.repositoryPath, 'locks', 'repository.lock', 'owner.json')
  const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { lockId: string }
  owner.lockId = '00000000-0000-4000-8000-000000000000'
  await writeFile(ownerPath, JSON.stringify(owner))
}

async function readManifest(
  repository: TestRepository,
  pointId: string,
): Promise<RecoveryPointManifestV1> {
  const handle = await openRepository(repository.repositoryPath, {
    intent: 'read',
    expectedRepositoryId: repository.repositoryId,
    expectedProtection: repository.protection,
    credentialProvider: repository.credentials,
  })
  try {
    const name = repository.protection === 'encrypted' ? 'manifest.enc' : 'manifest.json'
    const protectedContent = await readFile(join(handle.layout.points, pointId, name))
    if (!handle.protector) throw new Error('missing protector')
    const plaintext = await handle.protector.open(protectedContent, {
      repositoryId: repository.repositoryId,
      purpose: 'manifest',
      objectId: pointId,
    })
    return JSON.parse(plaintext.toString('utf8')) as RecoveryPointManifestV1
  } finally {
    handle.close()
  }
}

async function treeDigest(path: string): Promise<string> {
  const entries: string[] = []
  async function walk(current: string, prefix = ''): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        entries.push(`d:${relative}`)
        await walk(full, relative)
      } else {
        entries.push(
          `f:${relative}:${createHash('sha256')
            .update(await readFile(full))
            .digest('hex')}`,
        )
      }
    }
  }
  await walk(path)
  return entries.join('\n')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v1 backup source gates', () => {
  it('blocks a required missing source and publishes an optional missing source as a warning', async () => {
    const repository = await createRepository()
    const required = join(repository.root, 'required-missing')
    const requiredResult = await createV1RecoveryPoint(
      backupOptions(repository, [sourcePlugin(required)], 'required-failure'),
    )
    expect(requiredResult).toMatchObject({ state: 'failure', category: 'source' })
    expect(requiredResult.verificationScope).toBe('structural')
    expect(await pointNames(repository)).toEqual([])

    const optional = sourcePlugin(join(repository.root, 'optional-missing'), {
      requirement: 'optional',
    })
    const optionalResult = await createV1RecoveryPoint(
      backupOptions(repository, [optional], 'optional-warning'),
    )
    expect(optionalResult).toMatchObject({ state: 'warning', category: 'warning' })
    expect(await pointNames(repository)).toEqual(['optional-warning'])
    expect((await readManifest(repository, 'optional-warning')).sources[0]).toMatchObject({
      requirement: 'optional',
      status: 'missing',
    })
  })

  it('publishes an incomplete consistency group only as partial', async () => {
    const repository = await createRepository()
    const present = join(repository.root, 'present')
    await writeFile(present, 'present')
    const group = 'application-state'
    const plugins = [
      sourcePlugin(present, { name: 'present', requirement: 'optional', consistencyGroup: group }),
      sourcePlugin(join(repository.root, 'missing'), {
        name: 'missing',
        requirement: 'optional',
        consistencyGroup: group,
      }),
    ]

    const result = await createV1RecoveryPoint(backupOptions(repository, plugins, 'group-partial'))

    expect(result).toMatchObject({ state: 'partial', category: 'partial' })
    const manifest = await readManifest(repository, 'group-partial')
    expect(manifest.health).toBe('partial')
    expect(manifest.consistencyGroupsFailed).toEqual([group])
  })
})

describe('v1 pending publication', () => {
  for (const stage of [
    'content-written',
    'manifest-written',
    'before-publish',
  ] satisfies BackupWriteStage[]) {
    it(`does not expose a point interrupted at ${stage}`, async () => {
      const repository = await createRepository()
      const source = join(repository.root, 'source')
      await writeFile(source, 'content')

      const result = await createV1RecoveryPoint({
        ...backupOptions(repository, [sourcePlugin(source)], `interrupt-${stage}`),
        onStage(context) {
          if (context.stage === stage) throw new Error(`interrupt ${stage}`)
        },
      })

      expect(result.state).toBe('failure')
      expect(result.verificationScope).toBe('structural')
      expect(await pointNames(repository)).toEqual([])
    })
  }

  it('preserves diagnostic pending state and the primary category when cleanup fails', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    await writeFile(source, 'content')

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'cleanup-diagnostic'),
      onStage() {
        throw new Error('primary interruption')
      },
      async cleanupPending() {
        throw new Error('cleanup failure')
      },
    })

    expect(result).toMatchObject({ state: 'failure', category: 'internal' })
    expect(result.issues.map((issue) => issue.code)).toContain('PENDING_CLEANUP_FAILED')
    expect(await pointNames(repository)).toEqual(['cleanup-diagnostic.pending'])
  })

  it('fails a duplicate point ID without merging or replacing the first point', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    await writeFile(source, 'first')
    const options = backupOptions(repository, [sourcePlugin(source)], 'duplicate')
    expect((await createV1RecoveryPoint(options)).state).toBe('success')
    const firstManifest = await readManifest(repository, 'duplicate')
    expect(
      firstManifest.entries.every(
        (entry) => !Object.prototype.hasOwnProperty.call(entry, 'identity'),
      ),
    ).toBe(true)

    await writeFile(source, 'second')
    const duplicate = await createV1RecoveryPoint(options)

    expect(duplicate).toMatchObject({ state: 'failure', category: 'destination' })
    expect(duplicate.issues[0]?.code).toBe('DUPLICATE_RECOVERY_POINT')
    expect((await readManifest(repository, 'duplicate')).blobs[0]?.contentHash).toBe(
      firstManifest.blobs[0]?.contentHash,
    )
  })
})

describe('v1 protection and dry-run', () => {
  it('detects authenticated readback tampering and removes the pending point', async () => {
    const repository = await createRepository('encrypted')
    const source = join(repository.root, 'source')
    await writeFile(source, 'authenticated-content')
    let tampered = false

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'tampered'),
      async onStage(context) {
        if (context.stage === 'content-written' && !tampered) {
          tampered = true
          const content = await readFile(context.path)
          content[content.length - 1] ^= 1
          await writeFile(context.path, content)
        }
      },
    })

    expect(result).toMatchObject({ state: 'failure', category: 'authentication' })
    expect(await pointNames(repository)).toEqual([])
  })

  it('keeps encrypted source content and sensitive manifest paths out of repository bytes', async () => {
    const repository = await createRepository('encrypted')
    const source = join(repository.root, 'sensitive-source-name')
    const secret = 'unique plaintext backup secret'
    await writeFile(source, secret)

    const result = await createV1RecoveryPoint(
      backupOptions(repository, [sourcePlugin(source)], 'encrypted-point'),
    )

    expect(result.state).toBe('success')
    const repositoryBytes: Buffer[] = []
    async function collect(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name)
        if (entry.isDirectory()) await collect(full)
        else repositoryBytes.push(await readFile(full))
      }
    }
    await collect(repository.repositoryPath)
    const combined = Buffer.concat(repositoryBytes).toString('utf8')
    expect(combined).not.toContain(secret)
    expect(combined).not.toContain('sensitive-source-name')
  })

  it('requires and records per-source plaintext secret acceptance', async () => {
    const repository = await createRepository('plaintext')
    const source = join(repository.root, 'secret-source')
    await writeFile(source, 'secret')
    const plugin = sourcePlugin(source, { sensitivity: 'secret' })
    const options = backupOptions(repository, [plugin], 'plaintext-secret')

    const rejected = await createV1RecoveryPoint(options)
    expect(rejected).toMatchObject({ state: 'failure', category: 'configuration' })
    expect(rejected.issues[0]?.code).toBe('PLAINTEXT_SECRET_ACCEPTANCE_REQUIRED')
    expect(await pointNames(repository)).toEqual([])

    const acceptance: PlaintextSecretAcceptance = {
      repositoryId: repository.repositoryId,
      sourceId: 'plugin:source',
      sourceContractFingerprint: sourceContractFingerprint(options.plan.sources[0]),
      acceptedAt: '2026-07-19T00:00:00.000Z',
    }
    const accepted = await createV1RecoveryPoint({
      ...options,
      plaintextSecretAcceptances: [acceptance],
    })
    expect(accepted.state).toBe('success')
    expect((await readManifest(repository, 'plaintext-secret')).plaintextSecretAcceptances).toEqual(
      [acceptance],
    )
  })

  it('uses the same capture decisions in dry-run with zero repository writes', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    await mkdir(source)
    await writeFile(join(source, '.hidden'), 'hidden')
    const before = await treeDigest(repository.repositoryPath)

    const dryRun = await createV1RecoveryPoint({
      ...backupOptions(
        repository,
        [sourcePlugin(source, { expectedType: 'directory' })],
        'dry-run',
      ),
      dryRun: true,
    })

    expect(dryRun).toMatchObject({ state: 'success', category: 'success' })
    expect(dryRun.verificationScope).toBe('structural')
    expect(dryRun.counts.filesConsidered).toBe(2)
    expect(dryRun.counts.filesWritten).toBe(0)
    expect(await treeDigest(repository.repositoryPath)).toBe(before)
    expect(await pointNames(repository)).toEqual([])
  })
})

describe('v1 partial health and stable failure mapping', () => {
  it('publishes optional metadata fidelity loss only as partial and marks the manifest partial', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'metadata-source')
    await writeFile(source, 'content')

    const result = await createV1RecoveryPoint({
      ...backupOptions(
        repository,
        [sourcePlugin(source, { requirement: 'optional' })],
        'metadata-partial',
      ),
      capture: {
        metadataCommandRunner: async (executable) => {
          if (executable.endsWith('/stat')) return Buffer.from('-\n')
          throw new Error('permission denied')
        },
      },
    })

    expect(result).toMatchObject({ state: 'partial', category: 'partial' })
    expect(result.issues.map((issue) => issue.code)).toContain('METADATA_XATTR_UNREADABLE')
    expect((await readManifest(repository, 'metadata-partial')).health).toBe('partial')
  })

  it('maps incremental capture overflow to the stable source code', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'bounded-source')
    await mkdir(source)
    await writeFile(join(source, 'one'), '1234')
    await writeFile(join(source, 'two'), '5678')

    const result = await createV1RecoveryPoint({
      ...backupOptions(
        repository,
        [sourcePlugin(source, { expectedType: 'directory' })],
        'bounded-failure',
      ),
      capture: { attempts: 1, maxTotalBytes: 4 },
    })

    expect(result).toMatchObject({ state: 'failure', category: 'source' })
    expect(result.issues.map((issue) => issue.code)).toContain('CAPTURE_TOO_LARGE')
    expect(result.verificationScope).toBe('structural')
    expect(await pointNames(repository)).toEqual([])
  })
})

describe('v1 commit boundary and repository path identity', () => {
  it('rejects a points swap before the expected chain is held', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    const outside = join(repository.root, 'outside-pre-hold')
    await writeFile(source, 'sensitive-content')
    await mkdir(outside)

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'pre-hold-swap'),
      async beforeRepositoryPathHold(pointsPath) {
        await rename(pointsPath, `${pointsPath}.moved`)
        await symlink(outside, pointsPath)
      },
    })

    expect(result).toMatchObject({ state: 'failure', category: 'destination' })
    expect(result.issues.map((issue) => issue.code)).toContain('UNSAFE_REPOSITORY_PATH')
    expect(await readdir(outside)).toEqual([])
  })

  it('writes no sensitive bytes when a blobs parent remains redirected at open', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    const outside = join(repository.root, 'outside-file-open')
    await writeFile(source, 'sensitive-content')
    await mkdir(outside)
    let attacked = false

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'file-open-swap'),
      async beforeGuardedFileOpen(path) {
        if (attacked || !path.includes('/blobs/')) return
        attacked = true
        const blobs = join(path, '..')
        await rename(blobs, `${blobs}.moved`)
        await symlink(outside, blobs)
      },
    })

    expect(result).toMatchObject({ state: 'failure', category: 'destination' })
    const outsideFiles = await readdir(outside)
    expect(outsideFiles.length).toBeLessThanOrEqual(1)
    if (outsideFiles[0]) {
      expect(await stat(join(outside, outsideFiles[0]))).toMatchObject({ size: 0 })
      expect((await readFile(join(outside, outsideFiles[0]))).toString()).not.toContain(
        'sensitive-content',
      )
    }
  })

  it('rejects a restored blobs-parent ABA without writing sensitive bytes outside', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    const outside = join(repository.root, 'outside-restored-file-open')
    await writeFile(source, 'sensitive-restored-content')
    await mkdir(outside)
    let movedBlobs = ''
    let attacked = false
    let restored = false
    const restoredAbaHooks = {
      async beforeGuardedFileOpen(path: string) {
        if (attacked || !path.includes('/blobs/')) return
        attacked = true
        const blobs = join(path, '..')
        movedBlobs = `${blobs}.moved`
        await rename(blobs, movedBlobs)
        await symlink(outside, blobs)
      },
      async onGuardedWriterCwdBound(parentPath: string) {
        if (!movedBlobs || restored || !parentPath.endsWith('/blobs')) return
        await rm(parentPath)
        await rename(movedBlobs, parentPath)
        restored = true
      },
    }

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'restored-file-open-swap'),
      ...restoredAbaHooks,
    })

    expect(restored).toBe(true)
    expect(result).toMatchObject({ state: 'failure', category: 'destination' })
    const outsideBytes = await Promise.all(
      (await readdir(outside)).map((name) => readFile(join(outside, name))),
    )
    expect(Buffer.concat(outsideBytes).toString()).not.toContain('sensitive-restored-content')
    expect(await pointNames(repository)).toEqual([])
  })

  it('rejects a points swap in the directory-bound rename window without false publication', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    const outside = join(repository.root, 'outside-rename')
    await writeFile(source, 'sensitive-content')
    await mkdir(outside)

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'rename-window-swap'),
      async beforeDirectoryBoundCommit(pointsPath) {
        await rename(pointsPath, `${pointsPath}.moved`)
        await symlink(outside, pointsPath)
      },
    })

    expect(result).toMatchObject({ state: 'failure', category: 'destination' })
    expect(result.issues.map((issue) => issue.code)).toContain('UNSAFE_REPOSITORY_PATH')
    expect(await readdir(outside)).toEqual([])
  })

  for (const outputMode of ['suppress-after-commit', 'malformed-after-commit'] as const) {
    it(`reconciles a committed point when rename acknowledgement is ${outputMode}`, async () => {
      const repository = await createRepository()
      const source = join(repository.root, 'source')
      await writeFile(source, 'content')
      const commitWorkerTestOptions = { commitWorkerOutputMode: outputMode }

      const result = await createV1RecoveryPoint({
        ...backupOptions(repository, [sourcePlugin(source)], `lost-ack-${outputMode}`),
        ...commitWorkerTestOptions,
      })

      expect(result).toMatchObject({ state: 'degraded', category: 'destination' })
      expect(result.issues.map((issue) => issue.code)).toContain(
        'POINT_COMMIT_DURABILITY_UNCONFIRMED',
      )
      expect(await pointNames(repository)).toEqual([`lost-ack-${outputMode}`])
    })
  }

  it('returns committed degraded when durability fails after rename', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    await writeFile(source, 'content')

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'committed-degraded'),
      onStage(context) {
        if (context.stage === 'after-publish') throw new Error('points sync unavailable')
      },
    })

    expect(result).toMatchObject({ state: 'degraded', category: 'destination' })
    expect(result.issues.map((issue) => issue.code)).toContain(
      'POINT_COMMIT_DURABILITY_UNCONFIRMED',
    )
    expect(result.verificationScope).toBe('content')
    expect(await pointNames(repository)).toEqual(['committed-degraded'])
  })

  it('returns committed integrity degradation when published descriptor readback is corrupt', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    await writeFile(source, 'content')

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'published-corrupt'),
      async onStage(context) {
        if (context.stage === 'after-publish-sync') await writeFile(context.path, '{}')
      },
    })

    expect(result).toMatchObject({ state: 'degraded', category: 'integrity' })
    expect(result.issues.map((issue) => issue.code)).toContain('POINT_PUBLICATION_FAILED')
    expect(await pointNames(repository)).toEqual(['published-corrupt'])
  })

  for (const target of ['points', 'pending', 'blobs'] as const) {
    it(`fails closed when the repository ${target} directory is swapped`, async () => {
      const repository = await createRepository()
      const source = join(repository.root, 'source')
      const outside = join(repository.root, `outside-${target}`)
      await writeFile(source, 'content')
      await mkdir(outside)
      let swapped = false

      const result = await createV1RecoveryPoint({
        ...backupOptions(repository, [sourcePlugin(source)], `swap-${target}`),
        async onStage(context) {
          if (context.stage !== (target === 'points' ? 'manifest-written' : 'content-written')) {
            return
          }
          if (swapped) return
          swapped = true
          const path =
            target === 'points'
              ? join(repository.repositoryPath, 'points')
              : target === 'pending'
                ? context.pendingPath
                : join(context.pendingPath, 'blobs')
          await rename(path, `${path}.moved`)
          await symlink(outside, path)
        },
      })

      expect(result).toMatchObject({ state: 'failure', category: 'destination' })
      expect(result.issues.map((issue) => issue.code)).toContain('UNSAFE_REPOSITORY_PATH')
      expect(await readdir(outside)).toEqual([])
    })
  }

  it('records operation end after manifest sealing, publication, and sync', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    await writeFile(source, 'content')
    let tick = 0
    const now = () => new Date(Date.UTC(2026, 6, 19, 0, 0, tick++))

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'ended-after-sync'),
      now,
    })
    const manifest = await readManifest(repository, 'ended-after-sync')

    expect(new Date(result.endedAt).getTime()).toBeGreaterThan(
      new Date(manifest.completedAt).getTime(),
    )
  })
})

describe('v1 preflight ordering and acceptance binding', () => {
  it('runs prepare only after repository authorization and lock, and never in dry-run', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    await writeFile(source, 'content')
    let prepared = 0

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'prepare-order'),
      async beforeCapture() {
        prepared++
        expect(await readdir(join(repository.repositoryPath, 'locks'))).toContain('repository.lock')
      },
    })
    expect(result.state).toBe('success')
    expect(prepared).toBe(1)

    const dryRun = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'prepare-dry-run'),
      dryRun: true,
      async beforeCapture() {
        prepared++
      },
    })
    expect(dryRun.state).toBe('success')
    expect(prepared).toBe(1)
  })

  it('does not prepare when encrypted repository authentication fails', async () => {
    const repository = await createRepository('encrypted')
    const source = join(repository.root, 'source')
    await writeFile(source, 'content')
    let prepared = 0
    const missingCredentials = new MemoryCredentials()

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'prepare-auth-failure'),
      credentialProvider: missingCredentials,
      async beforeCapture() {
        prepared++
      },
    })

    expect(result.category).toBe('authentication')
    expect(prepared).toBe(0)
  })

  it('maps prepare exceptions to one stable source failure without leaking details', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source')
    await writeFile(source, 'content')

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'prepare-failure'),
      async beforeCapture() {
        throw new Error('/Users/example/.ssh/private-secret')
      },
    })

    expect(result).toMatchObject({ state: 'failure', category: 'source' })
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'PLUGIN_PREPARE_FAILED', category: 'source' }),
    ])
    expect(JSON.stringify(result)).not.toContain('private-secret')
    expect(await pointNames(repository)).toEqual([])
  })

  it('rejects plaintext acceptance after any source contract change', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'secret-source')
    await writeFile(source, 'secret')
    const options = backupOptions(
      repository,
      [sourcePlugin(source, { sensitivity: 'secret' })],
      'stale-acceptance',
    )
    const acceptance: PlaintextSecretAcceptance = {
      repositoryId: repository.repositoryId,
      sourceId: options.plan.sources[0].id,
      sourceContractFingerprint: sourceContractFingerprint(options.plan.sources[0]),
      acceptedAt: '2026-07-19T00:00:00.000Z',
    }
    options.plan.sources[0].recoveryScope = 'changed-contract'

    const result = await createV1RecoveryPoint({
      ...options,
      plaintextSecretAcceptances: [acceptance],
    })

    expect(result).toMatchObject({ state: 'failure', category: 'configuration' })
    expect(result.issues[0]?.code).toBe('PLAINTEXT_SECRET_ACCEPTANCE_REQUIRED')
  })
})

describe('v1 lock release degradation', () => {
  for (const initial of ['success', 'warning', 'partial'] as const) {
    it(`surfaces lock release failure after a published ${initial} result`, async () => {
      const repository = await createRepository()
      const source = join(repository.root, `source-${initial}`)
      if (initial !== 'warning') await writeFile(source, 'content')
      const plugin = sourcePlugin(source, {
        requirement: initial === 'success' ? 'required' : 'optional',
      })

      const result = await createV1RecoveryPoint({
        ...backupOptions(repository, [plugin], `lock-${initial}`),
        ...(initial === 'partial'
          ? {
              capture: {
                metadataCommandRunner: async (executable: string) => {
                  if (executable.endsWith('/stat')) return Buffer.from('-\n')
                  throw new Error('metadata denied')
                },
              },
            }
          : {}),
        async onStage(context) {
          if (context.stage !== 'after-publish-sync') return
          await corruptLockOwner(repository)
        },
      })

      expect(result).toMatchObject({ state: 'degraded', category: 'lock' })
      expect(result.issues.map((issue) => issue.code)).toContain('LOCK_OWNERSHIP_CHANGED')
      if (initial === 'success') expect(result.issues).toHaveLength(1)
      else expect(result.issues.length).toBeGreaterThan(1)
      expect(await pointNames(repository)).toEqual([`lock-${initial}`])
    })
  }

  it('preserves a post-publish degraded category when lock release also fails', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source-degraded')
    await writeFile(source, 'content')

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'lock-degraded'),
      async onStage(context) {
        if (context.stage !== 'after-publish') return
        await corruptLockOwner(repository)
        throw new Error('points durability unavailable')
      },
    })

    expect(result).toMatchObject({ state: 'degraded', category: 'destination' })
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['POINT_COMMIT_DURABILITY_UNCONFIRMED', 'LOCK_OWNERSHIP_CHANGED']),
    )
    expect(await pointNames(repository)).toEqual(['lock-degraded'])
  })

  it('preserves a pre-publication failure category when lock release also fails', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'source-failure')
    await writeFile(source, 'content')

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'lock-failure'),
      async onStage(context) {
        if (context.stage !== 'before-publish') return
        await corruptLockOwner(repository)
        throw new Error('publication interrupted')
      },
    })

    expect(result).toMatchObject({ state: 'failure', category: 'internal' })
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['BACKUP_FAILED', 'LOCK_OWNERSHIP_CHANGED']),
    )
    expect(result.issues.map((issue) => issue.code)).toContain('PENDING_CLEANUP_FAILED')
    expect(await pointNames(repository)).toEqual(['lock-failure.pending'])
  })
})

describe('v1 delegated repository lock', () => {
  it('uses a valid caller lease, blocks another writer, and never releases it', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'delegated-source')
    await writeFile(source, 'content')
    const handle = await openRepository(repository.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: repository.protection,
    })
    const lock = await acquireRepositoryLock(handle, 'migration')

    const result = await createV1RecoveryPoint({
      ...backupOptions(repository, [sourcePlugin(source)], 'delegated-lock'),
      heldLock: lock,
      async beforeCapture() {
        await expect(acquireRepositoryLock(handle, 'competing-backup')).rejects.toMatchObject({
          code: 'REPOSITORY_LOCKED',
        })
      },
    })

    expect(result.state).toBe('success')
    expect(await inspectRepositoryLock(handle)).toMatchObject({
      state: 'locked',
      metadata: { lockId: lock.metadata.lockId, operation: 'migration' },
    })
    await expect(acquireRepositoryLock(handle, 'after-writer')).rejects.toMatchObject({
      code: 'REPOSITORY_LOCKED',
    })
    await lock.release()
    handle.close()
  })

  it('rejects forged, released, cross-repository, and replaced delegated leases', async () => {
    const first = await createRepository()
    const second = await createRepository()
    const source = join(first.root, 'delegated-invalid-source')
    await writeFile(source, 'content')
    const firstHandle = await openRepository(first.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: first.repositoryId,
      expectedProtection: first.protection,
    })
    const secondHandle = await openRepository(second.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: second.repositoryId,
      expectedProtection: second.protection,
    })

    const forged = {
      metadata: {
        formatVersion: 1 as const,
        lockId: '00000000-0000-4000-8000-000000000000',
        owner: { pid: process.pid, hostname: 'forged', instanceId: 'forged' },
        operation: 'forged',
        startedAt: fixedNow().toISOString(),
      },
      async release() {},
    } satisfies RepositoryLock
    const forgedResult = await createV1RecoveryPoint({
      ...backupOptions(first, [sourcePlugin(source)], 'forged-lock'),
      heldLock: forged,
    })
    expect(forgedResult.issues[0]?.code).toBe('LOCK_CAPABILITY_INVALID')

    const released = await acquireRepositoryLock(firstHandle, 'released')
    await released.release()
    const releasedResult = await createV1RecoveryPoint({
      ...backupOptions(first, [sourcePlugin(source)], 'released-lock'),
      heldLock: released,
    })
    expect(releasedResult.issues[0]?.code).toBe('LOCK_CAPABILITY_RELEASED')

    const crossRepository = await acquireRepositoryLock(firstHandle, 'cross-repository')
    const crossResult = await createV1RecoveryPoint({
      ...backupOptions(second, [sourcePlugin(source)], 'cross-lock'),
      heldLock: crossRepository,
    })
    expect(crossResult.issues[0]?.code).toBe('LOCK_CAPABILITY_REPOSITORY_MISMATCH')
    await crossRepository.release()

    const replaced = await acquireRepositoryLock(firstHandle, 'replaced')
    const ownerPath = join(firstHandle.layout.repositoryLock, 'owner.json')
    const content = await readFile(ownerPath)
    await rename(ownerPath, `${ownerPath}.displaced`)
    await writeFile(ownerPath, content, { mode: 0o600 })
    const replacedResult = await createV1RecoveryPoint({
      ...backupOptions(first, [sourcePlugin(source)], 'replaced-lock'),
      heldLock: replaced,
    })
    expect(replacedResult.issues[0]?.code).toBe('LOCK_OWNERSHIP_CHANGED')

    firstHandle.close()
    secondHandle.close()
  })
})

describe('v1 captured metadata override contract', () => {
  it('leaves normal backup metadata unchanged when no override contract is supplied', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'normal-metadata-source')
    await writeFile(source, 'content', { mode: 0o640 })
    const options = backupOptions(repository, [sourcePlugin(source)], 'normal-metadata-parity')
    const baseline = await captureResolvedPlan(options.plan)

    const result = await createV1RecoveryPoint(options)
    const entry = (await readManifest(repository, 'normal-metadata-parity')).entries[0]

    expect(result.state).toBe('success')
    expect(entry?.metadata).toEqual(baseline.entries[0]?.metadata)
    for (const captured of baseline.entries) captured.content?.fill(0)
  })

  it('rejects missing, extra, duplicate, wrong-path/type/size, and malformed overrides', async () => {
    const repository = await createRepository()
    const source = join(repository.root, 'override-source')
    await writeFile(source, 'content', { mode: 0o600 })
    const sourceMetadata = await stat(source, { bigint: true })
    const valid: V1CapturedMetadataOverride = {
      sourceId: 'plugin:source',
      relativePath: '.',
      type: 'file',
      metadata: {
        mode: 0o600,
        size: Number(sourceMetadata.size),
        modifiedAtNs: sourceMetadata.mtimeNs.toString(),
      },
    }
    const cases: Array<{
      name: string
      overrides: V1CapturedMetadataOverride[]
      code: string
    }> = [
      { name: 'missing', overrides: [], code: 'CAPTURED_METADATA_OVERRIDE_MISMATCH' },
      {
        name: 'extra',
        overrides: [valid, { ...valid, relativePath: 'extra' }],
        code: 'CAPTURED_METADATA_OVERRIDE_MISMATCH',
      },
      {
        name: 'duplicate',
        overrides: [valid, { ...valid }],
        code: 'INVALID_CAPTURED_METADATA_OVERRIDE',
      },
      {
        name: 'wrong-path',
        overrides: [{ ...valid, relativePath: 'other' }],
        code: 'CAPTURED_METADATA_OVERRIDE_MISMATCH',
      },
      {
        name: 'wrong-type',
        overrides: [{ ...valid, type: 'directory' }],
        code: 'CAPTURED_METADATA_OVERRIDE_MISMATCH',
      },
      {
        name: 'wrong-size',
        overrides: [{ ...valid, metadata: { ...valid.metadata, size: valid.metadata.size + 1 } }],
        code: 'CAPTURED_METADATA_OVERRIDE_MISMATCH',
      },
      {
        name: 'malformed-mode',
        overrides: [{ ...valid, metadata: { ...valid.metadata, mode: 0o10000 } }],
        code: 'INVALID_CAPTURED_METADATA_OVERRIDE',
      },
      {
        name: 'malformed-mtime',
        overrides: [{ ...valid, metadata: { ...valid.metadata, modifiedAtNs: '1'.repeat(21) } }],
        code: 'INVALID_CAPTURED_METADATA_OVERRIDE',
      },
    ]

    for (const testCase of cases) {
      const result = await createV1RecoveryPoint({
        ...backupOptions(repository, [sourcePlugin(source)], `override-${testCase.name}`),
        capturedMetadataOverrides: testCase.overrides,
      })
      expect(result).toMatchObject({
        state: 'failure',
        issues: [{ code: testCase.code }],
      })
    }
    expect(await pointNames(repository)).toEqual([])
  })
})

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCapturePlan } from '../../src/catalog/index.js'
import { createV1RecoveryPoint } from '../../src/engine/v1-backup.js'
import type { PluginManifest } from '../../src/plugin/types.js'
import type { CredentialProvider } from '../../src/protection/credentials.js'
import { MasterKey } from '../../src/protection/secrets.js'
import {
  APPLY_FIDELITY_CONSENT,
  applyStaging,
  browseRecoveryPoints,
  isRecoveryPointProtectedBySafety,
  readSafetyPoint,
  restoreMetadata,
  rollbackSafetyPoint,
  stageRecovery,
} from '../../src/recovery/index.js'
import { atomicEnsureDirectory, atomicPublish, lstatIdentity } from '../../src/recovery/safe-io.js'
import {
  readSafetyLeaseMetricsForTests,
  resetSafetyLeaseMetricsForTests,
} from '../../src/recovery/safety.js'
import type { ApplyOptions } from '../../src/recovery/types.js'
import { initializeRepository, openRepository } from '../../src/repository/index.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

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

async function fixture(
  protection: 'plaintext' | 'encrypted' = 'plaintext',
  options: {
    partial?: boolean
    restrictiveDirectories?: boolean
    sensitivity?: 'public' | 'private' | 'secret'
    extraFiles?: number
  } = {},
) {
  const created = await mkdtemp(join(tmpdir(), 'restore-recovery-'))
  const root = await realpath(created)
  roots.push(root)
  const repositoryTarget = join(root, 'repository-target')
  const source = join(root, 'source')
  const stagingRoot = join(root, 'staging')
  await Promise.all([mkdir(repositoryTarget), mkdir(source), mkdir(stagingRoot)])
  await mkdir(join(source, '.hidden'))
  await writeFile(join(source, '.hidden', 'config'), 'saved config')
  await link(join(source, '.hidden', 'config'), join(source, 'hardlink'))
  await symlink('.hidden/config', join(source, 'link'))
  for (let index = 0; index < (options.extraFiles ?? 0); index++)
    await writeFile(join(source, `extra-${index.toString().padStart(3, '0')}`), `saved-${index}`)
  const optionalSource = join(root, 'optional-source')
  if (options.partial) await writeFile(optionalSource, '00000')
  if (options.restrictiveDirectories) await chmod(join(source, '.hidden'), 0o500)
  const credentials = protection === 'encrypted' ? new MemoryCredentials() : undefined
  const repository = await initializeRepository({
    targetPath: repositoryTarget,
    protection,
    ...(credentials
      ? {
          credentialProvider: credentials,
          exportRecoveryCredential: async (material: string) => material,
        }
      : {}),
  })
  const plugin: PluginManifest = {
    name: 'settings',
    description: 'test settings',
    paths: options.partial ? [source, optionalSource] : [source],
    sources: [
      {
        name: 'config',
        path: source,
        requirement: 'required',
        sensitivity: options.sensitivity ?? 'private',
        expectedType: 'directory',
        recoveryScope: 'exact',
        includeEmptyDirectories: true,
      },
      ...(options.partial
        ? [
            {
              name: 'incompatible-optional',
              path: optionalSource,
              requirement: 'optional' as const,
              sensitivity: 'private' as const,
              expectedType: 'file' as const,
              recoveryScope: 'exact' as const,
              includeEmptyDirectories: false,
            },
          ]
        : []),
    ],
  }
  const backup = await createV1RecoveryPoint({
    repositoryPath: repository.repositoryPath,
    expectedRepositoryId: repository.repositoryId,
    expectedProtection: protection,
    ...(credentials ? { credentialProvider: credentials } : {}),
    plan: buildCapturePlan([plugin]),
    pointId: 'point-one',
    capture: {
      metadataCommandRunner: async (executable: string) =>
        Buffer.from(executable === '/usr/bin/stat' ? '-\n' : ''),
      ...(options.partial
        ? {
            attempts: 2,
            async onReadAttempt(path: string, attempt: number) {
              if (path === optionalSource)
                await writeFile(optionalSource, String(attempt).padStart(5, '0'))
            },
          }
        : {}),
    },
  })
  expect(backup.state).toBe(options.partial ? 'partial' : 'success')
  return { root, source, stagingRoot, credentials, ...repository }
}

function repositoryOptions(repository: Awaited<ReturnType<typeof fixture>>) {
  return {
    repositoryPath: repository.repositoryPath,
    expectedRepositoryId: repository.repositoryId,
    expectedProtection: repository.protection,
    metadata: { platform: 'linux' as const },
    fidelityConsent: APPLY_FIDELITY_CONSENT,
    ...(repository.credentials ? { credentialProvider: repository.credentials } : {}),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('recovery staging', () => {
  it('browses concrete point IDs and requires explicit consent for a partial point', async () => {
    const repository = await fixture('plaintext', { partial: true })
    const browsed = await browseRecoveryPoints(repositoryOptions(repository))
    expect(browsed.resolvedPointIds).toEqual(['point-one'])
    expect(browsed.points[0]).toMatchObject({
      pointId: 'point-one',
      manifestHealth: 'partial',
      structurallyHealthy: true,
    })

    const rejected = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      pointId: 'point-one',
    })
    expect(rejected).toMatchObject({ state: 'failure', category: 'configuration' })
    expect(await readdir(repository.stagingRoot)).toEqual([])

    const accepted = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      pointId: 'point-one',
      allowPartial: true,
      partialConsent: 'I_ACCEPT_PARTIAL_RECOVERY',
    })
    expect(accepted.partialAccepted).toBe(true)
    expect(accepted.stagingPath).not.toBeNull()
  })

  it('stages hidden files, symlinks, and hardlinks without changing the original tree', async () => {
    const repository = await fixture()
    const before = await readFile(join(repository.source, '.hidden', 'config'), 'utf8')
    const result = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: { kind: 'plugin', plugin: 'settings' },
    })

    expect(['success', 'partial']).toContain(result.state)
    expect(result.pointId).toBe('point-one')
    expect(result.stagingPath).not.toBeNull()
    expect(await readFile(join(repository.source, '.hidden', 'config'), 'utf8')).toBe(before)
    const descriptor = JSON.parse(
      await readFile(join(result.stagingPath as string, '.restore-stage.json'), 'utf8'),
    ) as { entries: Array<{ relativePath: string; stagingRelativePath: string }> }
    expect(descriptor.entries.map((entry) => entry.relativePath)).toEqual(
      expect.arrayContaining(['.hidden/config', 'hardlink', 'link']),
    )
    const config = descriptor.entries.find((entry) => entry.relativePath === '.hidden/config')
    const hardlink = descriptor.entries.find((entry) => entry.relativePath === 'hardlink')
    const [configStat, hardlinkStat] = await Promise.all([
      lstat(join(result.stagingPath as string, config?.stagingRelativePath as string)),
      lstat(join(result.stagingPath as string, hardlink?.stagingRelativePath as string)),
    ])
    expect(configStat.ino).toBe(hardlinkStat.ino)
  })

  it('reuses deterministic pending work and rejects a tampered final descriptor', async () => {
    const repository = await fixture()
    let interrupted = false
    const first = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      beforeStagePublish() {
        if (!interrupted) {
          interrupted = true
          throw new Error('stop before publish')
        }
      },
    })
    expect(first.state).toBe('failure')
    const resumed = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
    })
    expect(resumed.stagingPath, JSON.stringify(resumed)).not.toBeNull()

    const descriptorPath = join(resumed.stagingPath as string, '.restore-stage.json')
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<string, unknown>
    descriptor.pointCompletedAt = '2020-01-01T00:00:00.000Z'
    await writeFile(descriptorPath, JSON.stringify(descriptor))
    const rejected = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: resumed.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: join(repository.root, 'target') }],
    })
    expect(rejected.state).toBe('failure')
    expect(rejected.items).toEqual([])
  })

  it('rejects corrupt protected blobs and wrong encrypted credentials before staging', async () => {
    const corrupt = await fixture()
    const blobs = join(corrupt.repositoryPath, 'points', 'point-one', 'blobs')
    const [blob] = await readdir(blobs)
    await writeFile(join(blobs, blob), 'corrupt')
    const corruptResult = await stageRecovery({
      ...repositoryOptions(corrupt),
      stagingRoot: corrupt.stagingRoot,
    })
    expect(corruptResult).toMatchObject({ state: 'failure', category: 'integrity' })

    const encrypted = await fixture('encrypted')
    const wrong = new MemoryCredentials()
    const wrongKey = new MasterKey(Buffer.alloc(32, 7))
    await wrong.storeMasterKey(encrypted.repositoryId, wrongKey)
    wrongKey.dispose()
    const authResult = await stageRecovery({
      repositoryPath: encrypted.repositoryPath,
      expectedRepositoryId: encrypted.repositoryId,
      expectedProtection: 'encrypted',
      credentialProvider: wrong,
      stagingRoot: encrypted.stagingRoot,
    })
    expect(authResult).toMatchObject({ state: 'failure', category: 'authentication' })
  })

  it('applies a selected hardlink without applying its dependency-only anchor', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: 'hardlink' }],
      },
    })
    const descriptor = JSON.parse(
      await readFile(join(staged.stagingPath as string, '.restore-stage.json'), 'utf8'),
    ) as { entries: Array<{ relativePath: string; selectionRole: string }> }
    expect(descriptor.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: 'hardlink', selectionRole: 'selected' }),
        expect.objectContaining({ relativePath: '.hidden/config', selectionRole: 'dependency' }),
      ]),
    )
    const target = join(repository.root, 'hardlink-selection')
    const applied = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite',
      dryRun: false,
      metadata: { platform: 'linux' },
    })
    expect(applied.state).toBe('partial')
    expect(await readFile(join(target, 'hardlink'), 'utf8')).toBe('saved config')
    expect(await lstatIdentity(join(target, '.hidden', 'config'))).toBeNull()
    expect(applied.issues.map((entry) => entry.code)).toContain('HARDLINK_RELATION_NOT_SELECTED')
    expect(applied.counts.fidelityLoss).toBeGreaterThan(0)
    const retry = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite',
      dryRun: false,
      applyId: applied.applyId,
      metadata: { platform: 'linux' },
    })
    expect(retry.state).toBe('partial')
    expect(retry.applyId).toBe(applied.applyId)
    expect(retry.counts.fidelityLoss).toBeGreaterThan(0)
  })

  it('reports authenticated fidelity issues in dry-run and requires exact consent before Safety', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
    })
    const target = join(repository.root, 'fidelity-consent-target')
    const input = {
      ...repositoryOptions(repository),
      fidelityConsent: undefined,
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
    }
    const reviewed = await applyStaging(input)
    expect(reviewed).toMatchObject({ state: 'partial', category: 'partial', dryRun: true })
    expect(reviewed.nextAction).toContain(APPLY_FIDELITY_CONSENT)

    const beforeSafetyPublish = vi.fn()
    const rejected = await applyStaging({
      ...input,
      dryRun: false,
      fidelityConsent: 'not-the-consent-token',
      beforeSafetyPublish,
    })
    expect(rejected).toMatchObject({ state: 'failure', category: 'cancelled' })
    expect(rejected.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'APPLY_FIDELITY_CONSENT_REQUIRED' }),
      ]),
    )
    expect(rejected.nextAction).toContain(APPLY_FIDELITY_CONSENT)
    expect(beforeSafetyPublish).not.toHaveBeenCalled()
    expect(await lstatIdentity(target)).toBeNull()
  })

  it('binds the canonical authenticated fidelity issue set into the apply fingerprint', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
    })
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [
        { sourceId: 'settings:config', targetPath: join(repository.root, 'fingerprint-target') },
      ],
    }
    const portable = await applyStaging(input)
    const nativeFailure = await applyStaging({
      ...input,
      metadata: {
        platform: 'darwin',
        commandRunner: async () => {
          throw new Error('simulated native verification failure')
        },
      },
    })
    expect(portable.planFingerprint).not.toBe(nativeFailure.planFingerprint)
    expect(nativeFailure.issues.map((entry) => entry.code)).toContain('FLAGS_VERIFY_FAILED')
  })

  it('blocks a post-lock authenticated fidelity issue-set change before Safety', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
    })
    let verificationCalls = 0
    const shared = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [
        { sourceId: 'settings:config', targetPath: join(repository.root, 'changed-issues-target') },
      ],
    }
    await applyStaging({
      ...shared,
      metadata: {
        platform: 'darwin',
        commandRunner: async () => {
          verificationCalls += 1
          return { stdout: Buffer.from('-') }
        },
      },
    })
    const initialVerificationCalls = verificationCalls
    verificationCalls = 0
    const beforeSafetyPublish = vi.fn()
    const result = await applyStaging({
      ...shared,
      dryRun: false,
      beforeSafetyPublish,
      metadata: {
        platform: 'darwin',
        commandRunner: async () => {
          verificationCalls += 1
          if (verificationCalls > initialVerificationCalls)
            throw new Error('post-lock verification failure')
          return { stdout: Buffer.from('-') }
        },
      },
    })
    expect(result).toMatchObject({ state: 'failure', category: 'integrity' })
    expect(result.issues.map((entry) => entry.code)).toContain('APPLY_FIDELITY_CHANGED')
    expect(beforeSafetyPublish).not.toHaveBeenCalled()
  })

  it('finalizes restrictive nested directory metadata only after its contents', async () => {
    const repository = await fixture('plaintext', { restrictiveDirectories: true })
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
    })
    expect(['success', 'partial']).toContain(staged.state)
    const descriptor = JSON.parse(
      await readFile(join(staged.stagingPath as string, '.restore-stage.json'), 'utf8'),
    ) as { entries: Array<{ relativePath: string; stagingRelativePath: string }> }
    const hidden = descriptor.entries.find((entry) => entry.relativePath === '.hidden')
    const hiddenPath = join(staged.stagingPath as string, hidden?.stagingRelativePath as string)
    expect((await lstat(hiddenPath)).mode & 0o777).toBe(0o500)
    expect(await readFile(join(hiddenPath, 'config'), 'utf8')).toBe('saved config')
    await Promise.all([chmod(join(repository.source, '.hidden'), 0o700), chmod(hiddenPath, 0o700)])
  })

  it('rejects noncanonical staging metadata without leaking secret paths or entry IDs', async () => {
    const repository = await fixture('encrypted', { sensitivity: 'secret' })
    const stageInput = {
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths' as const,
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    }
    const staged = await stageRecovery(stageInput)
    const descriptorPath = join(staged.stagingPath as string, '.restore-stage.json')
    const original = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
      stagingId: string
      plugins: string[]
      createdAt: string
      sources: Array<{ sensitivity: string }>
      entries: Array<{ id: string }>
    }
    expect(original.sources[0]?.sensitivity).toBe('secret')
    const secretTarget = join(repository.root, 'do-not-leak-secret-target')
    const mutations: Array<(descriptor: typeof original) => void> = [
      (descriptor) => {
        descriptor.sources[0].sensitivity = 'public'
      },
      (descriptor) => {
        descriptor.stagingId = `${descriptor.stagingId}-tampered`
      },
      (descriptor) => {
        descriptor.plugins = ['tampered-plugin']
      },
      (descriptor) => {
        descriptor.createdAt = '2020-01-01T00:00:00.000Z'
      },
    ]
    for (const mutate of mutations) {
      const descriptor = structuredClone(original)
      mutate(descriptor)
      await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`)
      const restaged = await stageRecovery(stageInput)
      expect(restaged).toMatchObject({ state: 'failure', category: 'integrity' })
      const rejected = await applyStaging({
        ...repositoryOptions(repository),
        stagingPath: staged.stagingPath as string,
        targets: [{ sourceId: 'settings:config', targetPath: secretTarget }],
        conflictPolicy: 'overwrite',
      })
      expect(rejected).toMatchObject({ state: 'failure', category: 'integrity', items: [] })
      const publicResult = JSON.stringify(rejected)
      expect(publicResult).not.toContain(secretTarget)
      for (const entry of original.entries) expect(publicResult).not.toContain(entry.id)
      expect(await lstatIdentity(secretTarget)).toBeNull()
    }
    await writeFile(descriptorPath, `${JSON.stringify(original)}\n`)
  })

  it('rejects canonical staging copied inside its repository before creating control state', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const copiedStaging = join(repository.repositoryPath, staged.stagingId as string)
    await cp(staged.stagingPath as string, copiedStaging, { recursive: true })
    const target = join(repository.root, 'overlap-target')
    const rejected = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: copiedStaging,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite',
      dryRun: false,
    })
    expect(rejected.state, JSON.stringify(rejected)).toBe('failure')
    expect(
      rejected.issues.map((entry) => entry.code),
      JSON.stringify(rejected),
    ).toContain('STAGING_REPOSITORY_OVERLAP')
    expect(rejected.items).toEqual([])
    expect(await lstatIdentity(target)).toBeNull()
    expect(await lstatIdentity(join(copiedStaging, '.restore-control'))).toBeNull()
  })

  it('rejects a staged hardlink split into a same-content independent file', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
    })
    const descriptor = JSON.parse(
      await readFile(join(staged.stagingPath as string, '.restore-stage.json'), 'utf8'),
    ) as {
      entries: Array<{
        id: string
        hardlinkTo?: string
        stagingRelativePath: string
      }>
    }
    const linked = descriptor.entries.find((entry) => entry.hardlinkTo)
    if (!linked) throw new Error('fixture hardlink missing')
    const linkedPath = join(staged.stagingPath as string, linked.stagingRelativePath)
    const content = await readFile(linkedPath)
    await rm(linkedPath)
    await writeFile(linkedPath, content)
    const target = join(repository.root, 'split-hardlink-target')
    const rejected = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite',
    })
    expect(rejected).toMatchObject({ state: 'failure', category: 'integrity', items: [] })
    expect(await lstatIdentity(target)).toBeNull()
  })
})

describe('apply and rollback', () => {
  it('enforces error, skip, and overwrite conflicts without deleting unrelated files', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'conflict-target')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(join(target, '.hidden', 'config'), 'current config')
    await writeFile(join(target, 'keep-me'), 'unrelated')
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
    }

    const conflict = await applyStaging({ ...input, conflictPolicy: 'error' })
    expect(conflict).toMatchObject({ state: 'failure', category: 'destination', dryRun: true })
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('current config')

    const skipped = await applyStaging({ ...input, conflictPolicy: 'skip' })
    expect(skipped).toMatchObject({ state: 'warning', category: 'warning', dryRun: true })
    expect(skipped.counts.skipped).toBeGreaterThan(0)

    const overwritten = await applyStaging({
      ...input,
      conflictPolicy: 'overwrite',
      dryRun: false,
    })
    expect(['success', 'partial']).toContain(overwritten.state)
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('saved config')
    expect(await readFile(join(target, 'keep-me'), 'utf8')).toBe('unrelated')
  })

  it('refuses broad, overlapping, and symlink-parent targets before mutation', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const realParent = join(repository.root, 'real-parent')
    const linkedParent = join(repository.root, 'linked-parent')
    await mkdir(realParent)
    await symlink(realParent, linkedParent)
    for (const target of [
      '/',
      join(repository.repositoryPath, 'unsafe'),
      join(linkedParent, 'unsafe'),
    ]) {
      const result = await applyStaging({
        ...repositoryOptions(repository),
        stagingPath: staged.stagingPath as string,
        targets: [{ sourceId: 'settings:config', targetPath: target }],
        conflictPolicy: 'overwrite',
      })
      expect(result).toMatchObject({ state: 'failure', category: 'destination' })
      expect(result.items).toEqual([])
    }
  })

  it('defaults to dry-run, applies with a durable Safety Point, and explicitly rolls back new paths', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
    })
    const target = join(repository.root, 'target')
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
    }
    const dryRun = await applyStaging(input)
    expect(dryRun).toMatchObject({ dryRun: true })
    expect(await lstatIdentity(target)).toBeNull()

    const applied = await applyStaging({ ...input, dryRun: false })
    expect(['success', 'partial']).toContain(applied.state)
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('saved config')
    const [appliedConfig, appliedHardlink] = await Promise.all([
      lstat(join(target, '.hidden', 'config')),
      lstat(join(target, 'hardlink')),
    ])
    expect(appliedConfig.ino).toBe(appliedHardlink.ino)
    expect(applied.safetyId).toMatch(/^safety-/)

    const rollbackDryRun = await rollbackSafetyPoint({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      safetyId: applied.safetyId as string,
    })
    expect(rollbackDryRun.state, JSON.stringify(rollbackDryRun)).toBe('warning')
    expect(rollbackDryRun.issues[0]?.code).toBe('ROLLBACK_DELETE_CONSENT_REQUIRED')

    const rolledBack = await rollbackSafetyPoint({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      safetyId: applied.safetyId as string,
      dryRun: false,
      deleteNewlyCreated: true,
    })
    expect(['success', 'partial'], JSON.stringify(rolledBack)).toContain(rolledBack.state)
    expect(await lstatIdentity(target)).toBeNull()
    const opened = await openRepository(repository.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: repository.protection,
    })
    if (!opened.protector) throw new Error('fixture repository has no protector')
    const readFailure = Object.assign(new Error('simulated safety directory I/O failure'), {
      code: 'EIO',
    })
    await expect(
      isRecoveryPointProtectedBySafety(
        staged.stagingPath as string,
        staged.pointId as string,
        repository.repositoryId,
        opened.protector,
        {
          openDirectory: async () => {
            throw readFailure
          },
        },
      ),
    ).rejects.toBe(readFailure)
    expect(
      await isRecoveryPointProtectedBySafety(
        staged.stagingPath as string,
        staged.pointId as string,
        repository.repositoryId,
        opened.protector,
      ),
    ).toBe(rolledBack.state === 'partial')
    opened.close()
  })

  it('persists the published phase and resumes after a post-publish interruption', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'single-file')
    let interrupted = false
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
      dryRun: false,
    }
    const first = await applyStaging({
      ...input,
      afterTargetPublish(_targetPath, entry) {
        if (!interrupted && entry.relativePath === '.hidden/config') {
          interrupted = true
          throw new Error('lost caller after publish')
        }
      },
    })
    expect(first.state).toBe('failure')
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('saved config')

    const opened = await openRepository(repository.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: repository.protection,
    })
    if (!opened.protector) throw new Error('fixture repository has no protector')
    expect(
      await isRecoveryPointProtectedBySafety(
        staged.stagingPath as string,
        staged.pointId as string,
        repository.repositoryId,
        opened.protector,
      ),
    ).toBe(true)
    opened.close()

    const resumed = await applyStaging({ ...input, applyId: first.applyId })
    expect(['success', 'partial'], JSON.stringify(resumed)).toContain(resumed.state)
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('saved config')
  })

  it('blocks descendants when a previously published directory is replaced', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'ancestor-aba')
    let interrupted = false
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
      dryRun: false,
    }
    const first = await applyStaging({
      ...input,
      afterTargetPublish(_targetPath, entry) {
        if (!interrupted && entry.relativePath === '.') {
          interrupted = true
          throw new Error('crash after publishing root directory')
        }
      },
    })
    expect(first.state).toBe('failure')
    const displaced = join(repository.root, 'ancestor-aba-displaced')
    await rename(target, displaced)
    await mkdir(target)
    await writeFile(join(target, 'user-sentinel'), 'preserve me')

    const resumed = await applyStaging({ ...input, applyId: first.applyId })
    expect(resumed).toMatchObject({ state: 'failure', category: 'destination' })
    expect(resumed.issues.map((entry) => entry.code)).toContain('APPLY_TARGET_DRIFT')
    expect(await readFile(join(target, 'user-sentinel'), 'utf8')).toBe('preserve me')
    expect(await lstatIdentity(join(target, '.hidden', 'config'))).toBeNull()
    expect(await lstatIdentity(join(displaced, '.hidden', 'config'))).toBeNull()
  })

  it('rejects same-content inode ABA on an applied non-directory resume fast-path', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'applied-file-aba')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(join(target, '.hidden', 'config'), 'old config')
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
      dryRun: false,
    }
    const applied = await applyStaging(input)
    const opened = await openRepository(repository.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: repository.protection,
    })
    if (!opened.protector || !applied.safetyId) throw new Error('fixture protector missing')
    const safety = await readSafetyPoint(
      staged.stagingPath as string,
      applied.safetyId,
      repository.repositoryId,
      opened.protector,
    )
    const appliedFile = join(target, '.hidden', 'config')
    const fileBinding = safety.planItems.find((item) => item.targetPath === appliedFile)
    if (!fileBinding) throw new Error('file plan binding missing')
    const journalPath = join(
      staged.stagingPath as string,
      '.restore-control',
      'journals',
      `${applied.applyId}.protected`,
    )
    const protectedJournal = await readFile(journalPath)
    const journalPlaintext = await opened.protector.open(protectedJournal, {
      repositoryId: repository.repositoryId,
      purpose: 'manifest',
      objectId: `restore-apply-journal:${applied.applyId}`,
    })
    const journal = JSON.parse(journalPlaintext.toString('utf8')) as {
      items: Array<Record<string, unknown>>
    }
    const fileProgress = journal.items.find((item) => item.entryId === fileBinding.entryId)
    if (!fileProgress) throw new Error('file journal progress missing')
    fileProgress.status = 'applied'
    fileProgress.issueCode = undefined
    fileProgress.fidelityLoss = undefined
    const rewrittenJournal = await opened.protector.seal(Buffer.from(JSON.stringify(journal)), {
      repositoryId: repository.repositoryId,
      purpose: 'manifest',
      objectId: `restore-apply-journal:${applied.applyId}`,
    })
    await writeFile(journalPath, rewrittenJournal)
    const displaced = join(target, '.hidden', 'config-displaced')
    await rename(appliedFile, displaced)
    await cp(displaced, appliedFile, { preserveTimestamps: true })
    const rejected = await applyStaging({ ...input, applyId: applied.applyId })
    expect(rejected).toMatchObject({ state: 'failure', category: 'destination' })
    expect(rejected.issues.map((entry) => entry.code)).toContain('APPLY_TARGET_DRIFT')
    expect(await readFile(appliedFile, 'utf8')).toBe('saved config')
    opened.close()
  })

  it('rejects mapping-parent ABA when resuming an authenticated apply', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const mappingParent = join(repository.root, 'resume-parent')
    const displacedParent = join(repository.root, 'resume-parent-displaced')
    const target = join(mappingParent, 'target')
    await mkdir(mappingParent)
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
      dryRun: false,
    }
    const applied = await applyStaging(input)
    await rename(mappingParent, displacedParent)
    await mkdir(mappingParent)
    await cp(join(displacedParent, 'target'), target, {
      recursive: true,
      preserveTimestamps: true,
    })
    const rejected = await applyStaging({ ...input, applyId: applied.applyId })
    expect(rejected).toMatchObject({ state: 'failure', category: 'destination' })
    expect(rejected.issues.map((entry) => entry.code)).toContain('APPLY_TARGET_DRIFT')
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('saved config')
  })

  it('binds a top-level mapping parent and rejects replacement before root publication', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const mappingParent = join(repository.root, 'mapping-parent')
    const displacedParent = join(repository.root, 'mapping-parent-displaced')
    const target = join(mappingParent, 'target')
    await mkdir(mappingParent)
    let swapped = false
    const rejected = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite',
      dryRun: false,
      async beforeTargetPublish(_targetPath, entry) {
        if (swapped || entry.relativePath !== '.') return
        swapped = true
        await rename(mappingParent, displacedParent)
        await mkdir(mappingParent)
        await writeFile(join(mappingParent, 'user-sentinel'), 'preserve me')
      },
    })
    expect(swapped).toBe(true)
    expect(rejected).toMatchObject({ state: 'failure', category: 'destination' })
    expect(rejected.issues.map((entry) => entry.code)).toContain('APPLY_TARGET_DRIFT')
    expect(await readFile(join(mappingParent, 'user-sentinel'), 'utf8')).toBe('preserve me')
    expect(await lstatIdentity(target)).toBeNull()
    expect(await lstatIdentity(join(displacedParent, 'target'))).toBeNull()
  })

  it('binds the dry-run destructive set to expected identities in the apply ID', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'reviewed-plan')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(join(target, '.hidden', 'config'), 'old config')
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
    }
    const reviewed = await applyStaging(input)
    expect(reviewed).toMatchObject({ state: 'success', dryRun: true })
    await writeFile(join(target, '.hidden', 'config'), 'changed after review')
    const rejected = await applyStaging({
      ...input,
      applyId: reviewed.applyId,
      dryRun: false,
    })
    expect(rejected).toMatchObject({ state: 'failure', category: 'configuration' })
    expect(rejected.issues.map((entry) => entry.code)).toContain('APPLY_RESUME_MISMATCH')
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('changed after review')
  })

  it('revalidates reviewed unchanged items after the Safety publication hook', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'unchanged-after-review')
    await cp(repository.source, target, { recursive: true, preserveTimestamps: true })
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
    }
    const reviewed = await applyStaging(input)
    expect(reviewed.items.some((item) => item.status === 'unchanged')).toBe(true)
    let hookRan = false
    const rejected = await applyStaging({
      ...input,
      applyId: reviewed.applyId,
      dryRun: false,
      async beforeSafetyPublish() {
        hookRan = true
        await writeFile(join(target, '.hidden', 'config'), 'changed in Safety hook')
      },
    })
    expect(hookRan).toBe(true)
    expect(rejected).toMatchObject({ state: 'failure', category: 'destination' })
    expect(rejected.issues.map((entry) => entry.code)).toContain('APPLY_TARGET_DRIFT')
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('changed in Safety hook')
  })

  it('rejects pending target drift during Safety publication without rebinding', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'pending-safety-drift')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(join(target, '.hidden', 'config'), 'reviewed old value')
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
    }
    const reviewed = await applyStaging(input)
    const rejected = await applyStaging({
      ...input,
      applyId: reviewed.applyId,
      dryRun: false,
      async beforeSafetyPublish() {
        await writeFile(join(target, '.hidden', 'config'), 'unreviewed replacement')
      },
    })
    expect(rejected).toMatchObject({ state: 'failure', category: 'destination' })
    expect(rejected.issues.map((entry) => entry.code)).toContain('APPLY_TARGET_DRIFT')
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('unreviewed replacement')
  })

  it('final-verifies unchanged siblings after pending publications', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
    })
    const target = join(repository.root, 'unchanged-sibling-final')
    await cp(repository.source, target, { recursive: true, preserveTimestamps: true })
    await rm(join(target, 'hardlink'))
    await link(join(target, '.hidden', 'config'), join(target, 'hardlink'))
    await rm(join(target, 'link'))
    await symlink('wrong-target', join(target, 'link'))
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
    }
    const reviewed = await applyStaging(input)
    expect(reviewed.items.some((item) => item.status === 'unchanged')).toBe(true)
    let mutated = false
    const rejected = await applyStaging({
      ...input,
      applyId: reviewed.applyId,
      dryRun: false,
      async afterTargetPublish(_targetPath, entry) {
        if (mutated || entry.relativePath !== 'link') return
        mutated = true
        await writeFile(join(target, '.hidden', 'config'), 'changed by sibling hook')
      },
    })
    expect(mutated).toBe(true)
    expect(rejected).toMatchObject({ state: 'failure', category: 'destination' })
    expect(rejected.issues.map((entry) => entry.code)).toContain('APPLY_TARGET_DRIFT')
  })

  it('promotes unchanged directory ancestors for final metadata and rollback', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'promoted-directory-ancestor')
    await cp(repository.source, target, { recursive: true, preserveTimestamps: true })
    await writeFile(join(target, '.hidden', 'config'), 'old child content')
    const hiddenPath = join(target, '.hidden')
    const beforeDirectory = await lstat(hiddenPath, { bigint: true })
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
    }
    const reviewed = await applyStaging(input)
    expect(
      reviewed.items.find((item) => item.targetLabel === hiddenPath)?.status,
      JSON.stringify(reviewed),
    ).toBe('pending')
    const applied = await applyStaging({ ...input, applyId: reviewed.applyId, dryRun: false })
    expect(['success', 'partial']).toContain(applied.state)
    const appliedDirectory = await lstat(hiddenPath, { bigint: true })
    const sourceDirectory = await lstat(join(repository.source, '.hidden'), { bigint: true })
    expect(
      (appliedDirectory.mtimeNs - sourceDirectory.mtimeNs < 0n
        ? sourceDirectory.mtimeNs - appliedDirectory.mtimeNs
        : appliedDirectory.mtimeNs - sourceDirectory.mtimeNs) <= 1_000_000n,
    ).toBe(true)
    const rolledBack = await rollbackSafetyPoint({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      safetyId: applied.safetyId as string,
      deleteNewlyCreated: true,
      dryRun: false,
    })
    expect(['success', 'partial'], JSON.stringify(rolledBack)).toContain(rolledBack.state)
    const restoredDirectory = await lstat(hiddenPath, { bigint: true })
    expect(
      (restoredDirectory.mtimeNs - beforeDirectory.mtimeNs < 0n
        ? beforeDirectory.mtimeNs - restoredDirectory.mtimeNs
        : restoredDirectory.mtimeNs - beforeDirectory.mtimeNs) <= 1_000_000n,
    ).toBe(true)
    expect(await readFile(join(hiddenPath, 'config'), 'utf8')).toBe('old child content')
  })

  it('distinguishes confirmed pre-mutation directory drift from ambiguous publication', async () => {
    for (const scenario of ['precondition', 'post-mutation'] as const) {
      const repository = await fixture()
      const staged = await stageRecovery({
        ...repositoryOptions(repository),
        stagingRoot: repository.stagingRoot,
        selection: {
          kind: 'paths',
          paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
        },
      })
      const target = join(repository.root, `directory-outcome-${scenario}`)
      let appeared = false
      const rejected = await applyStaging({
        ...repositoryOptions(repository),
        stagingPath: staged.stagingPath as string,
        targets: [{ sourceId: 'settings:config', targetPath: target }],
        conflictPolicy: 'overwrite',
        dryRun: false,
        ...(scenario === 'post-mutation'
          ? { directoryAcknowledgementMode: 'crash-after-mutation' as const }
          : {
              async beforeTargetPublish(_targetPath: string, entry: { relativePath: string }) {
                if (appeared || entry.relativePath !== '.') return
                appeared = true
                await mkdir(target)
                await writeFile(join(target, 'user-sentinel'), 'preserve me')
              },
            }),
      })
      if (scenario === 'precondition') {
        expect(rejected).toMatchObject({ state: 'failure', category: 'destination' })
        expect(rejected.issues.map((entry) => entry.code)).toContain('APPLY_TARGET_DRIFT')
        expect(await readFile(join(target, 'user-sentinel'), 'utf8')).toBe('preserve me')
      } else {
        expect(rejected).toMatchObject({ state: 'failure', category: 'integrity' })
        expect(rejected.issues.map((entry) => entry.code)).toContain('APPLY_PUBLICATION_AMBIGUOUS')
        expect(
          rejected.issues.find((entry) => entry.code === 'APPLY_PUBLICATION_AMBIGUOUS')?.nextAction,
        ).toContain('Inspect')
      }
    }
  })

  it('authenticates and reuses encrypted Safety blobs after pre-manifest failure', async () => {
    const repository = await fixture('encrypted')
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'safety-failure')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(join(target, '.hidden', 'config'), 'old config')
    let failed = false
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
      dryRun: false,
    }
    const first = await applyStaging({
      ...input,
      beforeSafetyPublish() {
        if (!failed) {
          failed = true
          throw new Error('simulated Safety manifest publication failure')
        }
      },
    })
    expect(first.state).toBe('failure')
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('old config')
    expect(
      (
        await readdir(
          join(
            staged.stagingPath as string,
            '.restore-control',
            'safety',
            first.safetyId as string,
          ),
        )
      ).some((name) => name.endsWith('.blob')),
    ).toBe(true)

    const implicitRetry = await applyStaging(input)
    expect(implicitRetry).toMatchObject({ state: 'failure', category: 'integrity' })
    expect(implicitRetry.issues.map((entry) => entry.code)).toContain('INCOMPLETE_SAFETY_RESIDUE')

    const retry = await applyStaging({ ...input, applyId: first.applyId as string })
    expect(['success', 'partial'], JSON.stringify(retry)).toContain(retry.state)
    expect(retry.applyId).toBe(first.applyId)
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('saved config')
  })

  it('rejects changed and write-back-to-same-content files after a Safety intent', async () => {
    for (const scenario of ['changed-content', 'same-content-write-back'] as const) {
      const repository = await fixture('encrypted')
      const staged = await stageRecovery({
        ...repositoryOptions(repository),
        stagingRoot: repository.stagingRoot,
        selection: {
          kind: 'paths',
          paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
        },
      })
      const target = join(repository.root, `safety-file-drift-${scenario}`)
      const targetFile = join(target, '.hidden', 'config')
      await mkdir(join(target, '.hidden'), { recursive: true })
      await writeFile(targetFile, 'old config')
      const input = {
        ...repositoryOptions(repository),
        stagingPath: staged.stagingPath as string,
        targets: [{ sourceId: 'settings:config', targetPath: target }],
        conflictPolicy: 'overwrite' as const,
        dryRun: false,
      }
      const first = await applyStaging({
        ...input,
        beforeSafetyPublish() {
          throw new Error('leave authenticated Safety intent')
        },
      })
      expect(first.state).toBe('failure')
      await writeFile(targetFile, 'unrelated drift')
      if (scenario === 'same-content-write-back') await writeFile(targetFile, 'old config')
      const expectedContent = scenario === 'changed-content' ? 'unrelated drift' : 'old config'

      const implicitRetry = await applyStaging(input)
      expect(implicitRetry).toMatchObject({ state: 'failure', category: 'integrity' })
      expect(implicitRetry.issues.map((entry) => entry.code)).toContain('INCOMPLETE_SAFETY_RESIDUE')
      const explicitRetry = await applyStaging({ ...input, applyId: first.applyId as string })
      expect(explicitRetry).toMatchObject({ state: 'failure', category: 'integrity' })
      expect(explicitRetry.issues.map((entry) => entry.code)).toContain('INCOMPLETE_SAFETY_RESIDUE')
      expect(
        explicitRetry.issues.find((entry) => entry.code === 'INCOMPLETE_SAFETY_RESIDUE')
          ?.nextAction,
      ).toContain('inspect')
      expect(await readFile(targetFile, 'utf8')).toBe(expectedContent)
    }
  })

  it('rejects fake, extra, and wrong-ID incomplete Safety residue', async () => {
    for (const scenario of ['fake-current', 'extra-after-intent', 'wrong-valid-id'] as const) {
      const repository = await fixture()
      const staged = await stageRecovery({
        ...repositoryOptions(repository),
        stagingRoot: repository.stagingRoot,
        selection: {
          kind: 'paths',
          paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
        },
      })
      const target = join(repository.root, `safety-residue-${scenario}`)
      await mkdir(join(target, '.hidden'), { recursive: true })
      await writeFile(join(target, '.hidden', 'config'), 'old config')
      const input = {
        ...repositoryOptions(repository),
        stagingPath: staged.stagingPath as string,
        targets: [{ sourceId: 'settings:config', targetPath: target }],
        conflictPolicy: 'overwrite' as const,
      }
      const reviewed = await applyStaging(input)
      const currentSafetyId = `safety-${(reviewed.applyId as string).slice('apply-'.length)}`
      const safetyBase = join(staged.stagingPath as string, '.restore-control', 'safety')
      const applyId = reviewed.applyId as string
      if (scenario === 'extra-after-intent') {
        const first = await applyStaging({
          ...input,
          applyId,
          dryRun: false,
          beforeSafetyPublish() {
            throw new Error('leave authenticated Safety intent')
          },
        })
        expect(first.state).toBe('failure')
        await writeFile(join(safetyBase, currentSafetyId, 'extra.blob'), 'not allowed')
      } else {
        const currentSuffix = currentSafetyId.slice('safety-'.length)
        const residueId =
          scenario === 'fake-current'
            ? currentSafetyId
            : `safety-${currentSuffix.startsWith('0') ? '1' : '0'}${currentSuffix.slice(1)}`
        await mkdir(join(safetyBase, residueId), { recursive: true })
        await writeFile(join(safetyBase, residueId, 'fake.blob'), 'not authenticated')
      }
      const rejected = await applyStaging({ ...input, applyId, dryRun: false })
      expect(rejected).toMatchObject({ state: 'failure', category: 'integrity' })
      expect(rejected.issues.map((entry) => entry.code)).toContain('INCOMPLETE_SAFETY_RESIDUE')
      expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('old config')
    }
  })

  it('rejects symlink and directory drift from an authenticated Safety intent', async () => {
    for (const scenario of ['symlink', 'directory'] as const) {
      const repository = await fixture()
      const staged = await stageRecovery({
        ...repositoryOptions(repository),
        stagingRoot: repository.stagingRoot,
      })
      const target = join(repository.root, `safety-intent-${scenario}`)
      await cp(repository.source, target, { recursive: true, preserveTimestamps: true })
      if (scenario === 'symlink') {
        await rm(join(target, 'link'))
        await symlink('wrong-before-intent', join(target, 'link'))
      } else {
        await writeFile(join(target, '.hidden', 'config'), 'old config')
      }
      const input = {
        ...repositoryOptions(repository),
        stagingPath: staged.stagingPath as string,
        targets: [{ sourceId: 'settings:config', targetPath: target }],
        conflictPolicy: 'overwrite' as const,
        dryRun: false,
      }
      const first = await applyStaging({
        ...input,
        beforeSafetyPublish() {
          throw new Error('leave authenticated Safety intent')
        },
      })
      expect(first.state).toBe('failure')
      if (scenario === 'symlink') {
        await rm(join(target, 'link'))
        await symlink('changed-after-intent', join(target, 'link'))
      } else {
        await chmod(join(target, '.hidden'), 0o700)
      }
      const rejected = await applyStaging({ ...input, applyId: first.applyId as string })
      expect(rejected).toMatchObject({ state: 'failure', category: 'integrity' })
      expect(rejected.issues.map((entry) => entry.code)).toContain('INCOMPLETE_SAFETY_RESIDUE')
    }
  })

  it('rejects extra, missing-intent, and non-file children in finalized Safety roots', async () => {
    for (const scenario of ['extra', 'missing-intent', 'child-type'] as const) {
      const repository = await fixture()
      const staged = await stageRecovery({
        ...repositoryOptions(repository),
        stagingRoot: repository.stagingRoot,
        selection: {
          kind: 'paths',
          paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
        },
      })
      const target = join(repository.root, `final-safety-children-${scenario}`)
      await mkdir(join(target, '.hidden'), { recursive: true })
      await writeFile(join(target, '.hidden', 'config'), 'old config')
      const applied = await applyStaging({
        ...repositoryOptions(repository),
        stagingPath: staged.stagingPath as string,
        targets: [{ sourceId: 'settings:config', targetPath: target }],
        conflictPolicy: 'overwrite',
        dryRun: false,
      })
      expect(['success', 'partial'], JSON.stringify(applied)).toContain(applied.state)
      const root = join(
        staged.stagingPath as string,
        '.restore-control',
        'safety',
        applied.safetyId as string,
      )
      if (scenario === 'extra') await writeFile(join(root, 'extra'), 'not allowed')
      else {
        await rm(join(root, 'intent.protected'))
        if (scenario === 'child-type') await mkdir(join(root, 'intent.protected'))
      }
      const opened = await openRepository(repository.repositoryPath, {
        intent: 'read',
        expectedRepositoryId: repository.repositoryId,
        expectedProtection: repository.protection,
      })
      try {
        expect(opened.protector).toBeDefined()
        await expect(
          readSafetyPoint(
            staged.stagingPath as string,
            applied.safetyId as string,
            repository.repositoryId,
            opened.protector as NonNullable<typeof opened.protector>,
          ),
        ).rejects.toThrow(/Safety/)
      } finally {
        opened.close()
      }
    }
  })

  it('authenticates finalized intents and requires semantic equality with the manifest', async () => {
    for (const scenario of ['malformed', 'wrong-aad', 'valid-different'] as const) {
      const repository = await fixture('encrypted')
      const staged = await stageRecovery({
        ...repositoryOptions(repository),
        stagingRoot: repository.stagingRoot,
        selection: {
          kind: 'paths',
          paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
        },
      })
      const target = join(repository.root, `final-intent-auth-${scenario}`)
      await mkdir(join(target, '.hidden'), { recursive: true })
      await writeFile(join(target, '.hidden', 'config'), 'old config')
      const applied = await applyStaging({
        ...repositoryOptions(repository),
        stagingPath: staged.stagingPath as string,
        targets: [{ sourceId: 'settings:config', targetPath: target }],
        conflictPolicy: 'overwrite',
        dryRun: false,
      })
      expect(['success', 'partial'], JSON.stringify(applied)).toContain(applied.state)
      const root = join(
        staged.stagingPath as string,
        '.restore-control',
        'safety',
        applied.safetyId as string,
      )
      const opened = await openRepository(repository.repositoryPath, {
        intent: 'read',
        expectedRepositoryId: repository.repositoryId,
        expectedProtection: repository.protection,
        credentialProvider: repository.credentials,
      })
      if (!opened.protector) throw new Error('fixture protector missing')
      try {
        if (scenario === 'malformed') {
          await writeFile(join(root, 'intent.protected'), 'malformed')
        } else if (scenario === 'wrong-aad') {
          await cp(join(root, 'manifest.protected'), join(root, 'intent.protected'))
        } else {
          const protectedIntent = await readFile(join(root, 'intent.protected'))
          const plaintext = await opened.protector.open(protectedIntent, {
            repositoryId: repository.repositoryId,
            purpose: 'manifest',
            objectId: `${applied.safetyId}:intent`,
          })
          const intent = JSON.parse(plaintext.toString('utf8')) as { createdAt: string }
          intent.createdAt = new Date(Date.parse(intent.createdAt) + 1000).toISOString()
          const replacement = await opened.protector.seal(Buffer.from(JSON.stringify(intent)), {
            repositoryId: repository.repositoryId,
            purpose: 'manifest',
            objectId: `${applied.safetyId}:intent`,
          })
          try {
            await writeFile(join(root, 'intent.protected'), replacement)
          } finally {
            protectedIntent.fill(0)
            plaintext.fill(0)
            replacement.fill(0)
          }
        }
        await expect(
          readSafetyPoint(
            staged.stagingPath as string,
            applied.safetyId as string,
            repository.repositoryId,
            opened.protector,
          ),
        ).rejects.toThrow(/Safety/)
      } finally {
        opened.close()
      }
    }
  })

  it('resumes an exact post-manifest pre-protection crash only with the original apply ID', async () => {
    const repository = await fixture('encrypted')
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'missing-protection-resume')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(join(target, '.hidden', 'config'), 'old config')
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
      dryRun: false,
    }
    const first = await applyStaging({
      ...input,
      afterSafetyManifestPublish() {
        throw new Error('crash before protection publication')
      },
    })
    expect(first.state).toBe('failure')
    const root = join(
      staged.stagingPath as string,
      '.restore-control',
      'safety',
      first.safetyId as string,
    )
    expect(await readdir(root)).toContain('manifest.protected')
    expect(await lstatIdentity(join(root, 'protection.json'))).toBeNull()
    const implicit = await applyStaging(input)
    expect(implicit).toMatchObject({ state: 'failure', category: 'integrity' })
    expect(implicit.issues.map((entry) => entry.code)).toContain('INCOMPLETE_SAFETY_RESIDUE')
    const resumed = await applyStaging({ ...input, applyId: first.applyId as string })
    expect(['success', 'partial'], JSON.stringify(resumed)).toContain(resumed.state)
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('saved config')
  })

  it('fails before journaling or target mutation when the post-Safety hook changes artifacts', async () => {
    for (const scenario of ['corrupt', 'delete', 'add'] as const) {
      const repository = await fixture()
      const staged = await stageRecovery({
        ...repositoryOptions(repository),
        stagingRoot: repository.stagingRoot,
        selection: {
          kind: 'paths',
          paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
        },
      })
      const target = join(repository.root, `post-safety-artifact-${scenario}`)
      const targetFile = join(target, '.hidden', 'config')
      await mkdir(join(target, '.hidden'), { recursive: true })
      await writeFile(targetFile, 'old config')
      const input = {
        ...repositoryOptions(repository),
        stagingPath: staged.stagingPath as string,
        targets: [{ sourceId: 'settings:config', targetPath: target }],
        conflictPolicy: 'overwrite' as const,
      }
      const reviewed = await applyStaging(input)
      const safetyId = `safety-${(reviewed.applyId as string).slice('apply-'.length)}`
      const root = join(staged.stagingPath as string, '.restore-control', 'safety', safetyId)
      const rejected = await applyStaging({
        ...input,
        applyId: reviewed.applyId as string,
        dryRun: false,
        async afterSafetyPublish() {
          if (scenario === 'corrupt') await writeFile(join(root, 'intent.protected'), 'corrupt')
          else if (scenario === 'delete') await rm(join(root, 'intent.protected'))
          else await writeFile(join(root, 'extra'), 'unexpected')
        },
      })
      expect(rejected).toMatchObject({ state: 'failure', category: 'integrity' })
      expect(rejected.issues.map((entry) => entry.code)).toContain('INCOMPLETE_SAFETY_RESIDUE')
      expect(await readFile(targetFile, 'utf8')).toBe('old config')
      expect(
        await lstatIdentity(
          join(
            staged.stagingPath as string,
            '.restore-control',
            'journals',
            `${reviewed.applyId}.protected`,
          ),
        ),
      ).toBeNull()
    }
  })

  it('preflights every callback before mutation when a hook corrupts another entry blob', async () => {
    const repository = await fixture('plaintext', { extraFiles: 1 })
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [
          { sourceId: 'settings:config', relativePath: '.hidden/config' },
          { sourceId: 'settings:config', relativePath: 'extra-000' },
        ],
      },
    })
    const target = join(repository.root, 'cross-entry-safety-corruption')
    const firstTarget = join(target, '.hidden', 'config')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(firstTarget, 'old first')
    await writeFile(join(target, 'extra-000'), 'old second')
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
    }
    const reviewed = await applyStaging(input)
    const safetyId = `safety-${(reviewed.applyId as string).slice('apply-'.length)}`
    const otherEntryId = 'settings:config:extra-000'
    const otherBlob = `safety-${createHash('sha256').update(otherEntryId).digest('hex').slice(0, 32)}.blob`
    let corrupted = false
    const rejected = await applyStaging({
      ...input,
      applyId: reviewed.applyId as string,
      dryRun: false,
      async beforeTargetPublish() {
        if (corrupted) return
        corrupted = true
        await writeFile(
          join(staged.stagingPath as string, '.restore-control', 'safety', safetyId, otherBlob),
          'corrupt another entry',
        )
      },
    })
    expect(corrupted).toBe(true)
    expect(rejected).toMatchObject({ state: 'failure', category: 'integrity' })
    expect(await readFile(firstTarget, 'utf8')).toBe('old first')
    expect(await readFile(join(target, 'extra-000'), 'utf8')).toBe('old second')
  })

  it('keeps Safety lease descriptors and control-byte verification bounded at multi-file scale', async () => {
    const extraFiles = 16
    const repository = await fixture('plaintext', { extraFiles })
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
    })
    const target = join(repository.root, 'safety-lease-scale')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(join(target, '.hidden', 'config'), 'old config')
    for (let index = 0; index < extraFiles; index++)
      await writeFile(join(target, `extra-${index.toString().padStart(3, '0')}`), `old-${index}`)
    resetSafetyLeaseMetricsForTests()
    type HasPublicLeaseObserver = 'onSafetyLeaseValidation' extends keyof ApplyOptions
      ? true
      : false
    const hasPublicLeaseObserver: HasPublicLeaseObserver = false
    expect(hasPublicLeaseObserver).toBe(false)
    const applied = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite',
      dryRun: false,
    })
    expect(['success', 'partial'], JSON.stringify(applied)).toContain(applied.state)
    const metrics = readSafetyLeaseMetricsForTests()
    expect(metrics.peakHeldDescriptors).toBeLessThanOrEqual(4)
    expect(metrics.currentHeldDescriptors).toBe(0)
    expect(metrics.controlByteReads).toBeLessThanOrEqual(18)
    expect(metrics.entryValidations).toBeLessThanOrEqual(applied.items.length * 5)
    expect(metrics.artifactLookups).toBeLessThanOrEqual(metrics.entryValidations)
  })

  it('fully validates captured xattrs and flags when final Safety has no journal', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'final-safety-semantic-drift')
    const targetFile = join(target, '.hidden', 'config')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(targetFile, 'old config')
    let currentPath = ''
    let drifted = false
    const metadata = {
      platform: 'darwin' as const,
      onBeforeCommand(path: string) {
        currentPath = path
      },
      async commandRunner(executable: string, args: string[]) {
        const isTarget = currentPath.startsWith(target)
        if (executable === '/usr/bin/xattr' && args[0] === '-s')
          return { stdout: Buffer.from(isTarget ? 'com.example.restore\n' : '') }
        if (executable === '/usr/bin/xattr' && args[0] === '-p')
          return { stdout: Buffer.from(drifted ? '02\n' : '01\n') }
        if (executable === '/usr/bin/stat')
          return { stdout: Buffer.from(isTarget ? `${drifted ? 'archived' : 'hidden'}\n` : '-\n') }
        throw new Error(`unexpected metadata command: ${executable}`)
      },
    }
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
      dryRun: false,
      metadata,
    }
    const first = await applyStaging({
      ...input,
      afterSafetyPublish() {
        throw new Error('crash after final Safety and before journal')
      },
    })
    expect(first.state).toBe('failure')
    drifted = true
    const retry = await applyStaging({ ...input, applyId: first.applyId as string })
    expect(retry).toMatchObject({ state: 'failure', category: 'destination' })
    expect(retry.issues.map((entry) => entry.code)).toContain('APPLY_TARGET_DRIFT')
    expect(await readFile(targetFile, 'utf8')).toBe('old config')
  })

  it('rejects malformed nested protected journals and Safety manifests', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'malformed-control')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(join(target, '.hidden', 'config'), 'old config')
    let interrupted = false
    const input = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
      dryRun: false,
    }
    const first = await applyStaging({
      ...input,
      afterTargetPublish() {
        if (!interrupted) {
          interrupted = true
          throw new Error('stop with durable journal')
        }
      },
    })
    const opened = await openRepository(repository.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: repository.protection,
    })
    if (!opened.protector || !first.safetyId) throw new Error('fixture protection missing')

    const journalPath = join(
      staged.stagingPath as string,
      '.restore-control',
      'journals',
      `${first.applyId}.protected`,
    )
    const originalJournal = await readFile(journalPath)
    const journalPlaintext = await opened.protector.open(originalJournal, {
      repositoryId: repository.repositoryId,
      purpose: 'manifest',
      objectId: `restore-apply-journal:${first.applyId}`,
    })
    const malformedJournal = JSON.parse(journalPlaintext.toString('utf8')) as {
      items: Array<Record<string, unknown>>
    }
    malformedJournal.items[0].unexpected = true
    const protectedJournal = await opened.protector.seal(
      Buffer.from(JSON.stringify(malformedJournal)),
      {
        repositoryId: repository.repositoryId,
        purpose: 'manifest',
        objectId: `restore-apply-journal:${first.applyId}`,
      },
    )
    await writeFile(journalPath, protectedJournal)
    const journalRejected = await applyStaging({ ...input, applyId: first.applyId })
    expect(journalRejected).toMatchObject({ state: 'failure', category: 'integrity' })

    const zeroJournal = JSON.parse(journalPlaintext.toString('utf8')) as {
      items: Array<Record<string, unknown>>
    }
    const finalized = zeroJournal.items.find(
      (item) => item.status === 'published' || item.status === 'applied',
    )
    if (!finalized) throw new Error('finalized apply journal item missing')
    for (const key of [
      'finalDevice',
      'finalInode',
      'finalSize',
      'finalModifiedAtNs',
      'finalChangedAtNs',
    ])
      finalized[key] = '0'
    const protectedZeroJournal = await opened.protector.seal(
      Buffer.from(JSON.stringify(zeroJournal)),
      {
        repositoryId: repository.repositoryId,
        purpose: 'manifest',
        objectId: `restore-apply-journal:${first.applyId}`,
      },
    )
    await writeFile(journalPath, protectedZeroJournal)
    const zeroRejected = await applyStaging({ ...input, applyId: first.applyId })
    expect(zeroRejected).toMatchObject({ state: 'failure', category: 'integrity' })
    await writeFile(journalPath, originalJournal)

    const safety = await readSafetyPoint(
      staged.stagingPath as string,
      first.safetyId,
      repository.repositoryId,
      opened.protector,
    )
    const present = safety.entries.find((entry) => entry.before.state === 'present')
    if (!present || present.before.state !== 'present')
      throw new Error('present Safety entry missing')
    const malformedSafety = structuredClone(safety)
    const malformedPresent = malformedSafety.entries.find(
      (entry) => entry.entryId === present.entryId,
    )
    if (!malformedPresent || malformedPresent.before.state !== 'present')
      throw new Error('cloned Safety entry missing')
    ;(malformedPresent.before.metadata as unknown as Record<string, unknown>).unexpected = true
    const protectedSafety = await opened.protector.seal(
      Buffer.from(JSON.stringify(malformedSafety)),
      {
        repositoryId: repository.repositoryId,
        purpose: 'manifest',
        objectId: first.safetyId,
      },
    )
    await writeFile(
      join(
        staged.stagingPath as string,
        '.restore-control',
        'safety',
        first.safetyId,
        'manifest.protected',
      ),
      protectedSafety,
    )
    const safetyRejected = await rollbackSafetyPoint({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      safetyId: first.safetyId,
      deleteNewlyCreated: true,
    })
    expect(safetyRejected).toMatchObject({ state: 'failure', category: 'integrity' })
    opened.close()
  })

  it('refuses rollback after a user edits an applied target', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'drift-target')
    const applied = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite',
      dryRun: false,
    })
    const appliedFile = join(target, '.hidden', 'config')
    await writeFile(appliedFile, 'user edit')
    const rollback = await rollbackSafetyPoint({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      safetyId: applied.safetyId as string,
      deleteNewlyCreated: true,
    })
    expect(rollback).toMatchObject({ state: 'failure', category: 'destination' })
    expect(await readFile(appliedFile, 'utf8')).toBe('user edit')
  })

  it('durably resumes hardlink apply and rollback while preserving original topology', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
    })
    const target = join(repository.root, 'existing-hardlinks')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(join(target, '.hidden', 'config'), 'old linked config')
    await link(join(target, '.hidden', 'config'), join(target, 'hardlink'))
    await symlink('.hidden/config', join(target, 'link'))
    let applyInterrupted = false
    const applyInput = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite' as const,
      dryRun: false,
    }
    const firstApply = await applyStaging({
      ...applyInput,
      afterTargetPublish(_targetPath, entry) {
        if (!applyInterrupted && entry.relativePath === '.hidden/config') {
          applyInterrupted = true
          throw new Error('crash after first hardlink member')
        }
      },
    })
    expect(firstApply.state).toBe('failure')
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('saved config')
    expect(await readFile(join(target, 'hardlink'), 'utf8')).toBe('old linked config')

    const applied = await applyStaging({ ...applyInput, applyId: firstApply.applyId })
    expect(['success', 'partial'], JSON.stringify(applied)).toContain(applied.state)
    expect(await readFile(join(target, 'hardlink'), 'utf8')).toBe('saved config')
    const [appliedConfig, appliedHardlink] = await Promise.all([
      lstat(join(target, '.hidden', 'config')),
      lstat(join(target, 'hardlink')),
    ])
    expect(appliedConfig.ino).toBe(appliedHardlink.ino)

    let interrupted = false
    const rollbackInput = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      safetyId: applied.safetyId as string,
      dryRun: false,
      deleteNewlyCreated: true,
    }
    const first = await rollbackSafetyPoint({
      ...rollbackInput,
      afterTargetPublish() {
        if (!interrupted) {
          interrupted = true
          throw new Error('lost rollback acknowledgement')
        }
      },
    })
    expect(first.state).toBe('failure')

    const resumed = await rollbackSafetyPoint(rollbackInput)
    expect(['success', 'partial'], JSON.stringify(resumed)).toContain(resumed.state)
    expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('old linked config')
    const [config, hardlink] = await Promise.all([
      lstat(join(target, '.hidden', 'config')),
      lstat(join(target, 'hardlink')),
    ])
    expect(config.ino).toBe(hardlink.ino)
  })

  it('rejects rollback directory replacement and preserves the replacement tree', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
    })
    const target = join(repository.root, 'rollback-directory-aba')
    const displaced = join(repository.root, 'rollback-directory-aba-displaced')
    await mkdir(join(target, '.hidden'), { recursive: true })
    await writeFile(join(target, '.hidden', 'config'), 'old config')
    const applied = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite',
      dryRun: false,
    })
    expect(['success', 'partial']).toContain(applied.state)
    let swapped = false
    const rejected = await rollbackSafetyPoint({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      safetyId: applied.safetyId as string,
      deleteNewlyCreated: true,
      dryRun: false,
      async beforeTargetPublish(targetPath) {
        if (swapped || targetPath !== target) return
        swapped = true
        await rename(target, displaced)
        await mkdir(target)
        await writeFile(join(target, 'user-sentinel'), 'preserve me')
      },
    })
    expect(swapped).toBe(true)
    expect(rejected).toMatchObject({ state: 'failure', category: 'destination' })
    expect(rejected.issues.map((entry) => entry.code)).toContain('ROLLBACK_TARGET_DRIFT')
    expect(await readFile(join(target, 'user-sentinel'), 'utf8')).toBe('preserve me')
    expect(await readdir(target)).toEqual(['user-sentinel'])
  })

  it('rejects rollback after the authenticated mapping parent is replaced', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const mappingParent = join(repository.root, 'rollback-parent')
    const displacedParent = join(repository.root, 'rollback-parent-displaced')
    const target = join(mappingParent, 'target')
    await mkdir(mappingParent)
    const applied = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite',
      dryRun: false,
    })
    expect(['success', 'partial']).toContain(applied.state)
    await rename(mappingParent, displacedParent)
    await mkdir(mappingParent)
    await writeFile(join(mappingParent, 'user-sentinel'), 'preserve me')
    const rejected = await rollbackSafetyPoint({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      safetyId: applied.safetyId as string,
      deleteNewlyCreated: true,
      dryRun: false,
    })
    expect(rejected).toMatchObject({ state: 'failure', category: 'destination' })
    expect(rejected.issues.map((entry) => entry.code)).toContain('ROLLBACK_TARGET_DRIFT')
    expect(await readdir(mappingParent)).toEqual(['user-sentinel'])
    expect(await readFile(join(mappingParent, 'user-sentinel'), 'utf8')).toBe('preserve me')
    expect(await readFile(join(displacedParent, 'target', '.hidden', 'config'), 'utf8')).toBe(
      'saved config',
    )
  })

  it('resumes after deleting an originally absent root with a lost caller acknowledgement', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'rollback-absent-root-resume')
    const applied = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite',
      dryRun: false,
    })
    let interrupted = false
    const rollbackInput = {
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      safetyId: applied.safetyId as string,
      deleteNewlyCreated: true,
      dryRun: false,
    }
    const first = await rollbackSafetyPoint({
      ...rollbackInput,
      afterTargetPublish(targetPath) {
        if (interrupted || targetPath !== target) return
        interrupted = true
        throw new Error('lost root deletion acknowledgement')
      },
    })
    expect(first.state).toBe('failure')
    expect(await lstatIdentity(target)).toBeNull()
    const opened = await openRepository(repository.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: repository.protection,
    })
    if (!opened.protector) throw new Error('fixture protector missing')
    const rollbackJournalPath = join(
      staged.stagingPath as string,
      '.restore-control',
      'journals',
      `rollback-${applied.applyId}.protected`,
    )
    const originalJournal = await readFile(rollbackJournalPath)
    const journalPlaintext = await opened.protector.open(originalJournal, {
      repositoryId: repository.repositoryId,
      purpose: 'manifest',
      objectId: `restore-rollback-journal:${applied.applyId}`,
    })
    const extraJournal = JSON.parse(journalPlaintext.toString('utf8')) as {
      items: Array<Record<string, unknown>>
    }
    extraJournal.items.push({
      entryId: 'extra-authenticated-item',
      status: 'applied',
      finalDevice: '1',
      finalInode: '1',
      finalSize: '1',
      finalModifiedAtNs: '1',
      finalChangedAtNs: '1',
    })
    const protectedExtra = await opened.protector.seal(Buffer.from(JSON.stringify(extraJournal)), {
      repositoryId: repository.repositoryId,
      purpose: 'manifest',
      objectId: `restore-rollback-journal:${applied.applyId}`,
    })
    await writeFile(rollbackJournalPath, protectedExtra)
    const extraRejected = await rollbackSafetyPoint(rollbackInput)
    expect(extraRejected).toMatchObject({ state: 'failure', category: 'integrity' })
    expect(extraRejected.issues.map((entry) => entry.code)).toContain('ROLLBACK_JOURNAL_MISMATCH')
    await writeFile(rollbackJournalPath, originalJournal)
    opened.close()
    const resumed = await rollbackSafetyPoint(rollbackInput)
    expect(['success', 'partial'], JSON.stringify(resumed)).toContain(resumed.state)
    expect(await lstatIdentity(target)).toBeNull()
  })

  it('converges when an originally absent applied root is already removed', async () => {
    const repository = await fixture()
    const staged = await stageRecovery({
      ...repositoryOptions(repository),
      stagingRoot: repository.stagingRoot,
      selection: {
        kind: 'paths',
        paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
      },
    })
    const target = join(repository.root, 'rollback-already-removed-root')
    const applied = await applyStaging({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      targets: [{ sourceId: 'settings:config', targetPath: target }],
      conflictPolicy: 'overwrite',
      dryRun: false,
    })
    await rm(target, { recursive: true })
    const rollback = await rollbackSafetyPoint({
      ...repositoryOptions(repository),
      stagingPath: staged.stagingPath as string,
      safetyId: applied.safetyId as string,
      deleteNewlyCreated: true,
      dryRun: false,
    })
    expect(['success', 'partial'], JSON.stringify(rollback)).toContain(rollback.state)
    expect(await lstatIdentity(target)).toBeNull()
  })
})

describe('directory-bound atomic publish', () => {
  it('reconciles suppressed and malformed directory acknowledgements by final identity', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'restore-directory-ack-')))
    roots.push(root)
    for (const mode of ['suppress', 'malformed'] as const) {
      const target = join(root, mode)
      const final = await atomicEnsureDirectory(target, null, undefined, mode)
      expect(final.type).toBe('directory')
      const current = await lstatIdentity(target)
      expect(current?.device).toBe(final.device)
      expect(current?.inode).toBe(final.inode)
    }
  })

  it('resumes apply after a reconciled directory acknowledgement and interruption', async () => {
    for (const mode of ['suppress', 'malformed'] as const) {
      const repository = await fixture()
      const staged = await stageRecovery({
        ...repositoryOptions(repository),
        stagingRoot: repository.stagingRoot,
        selection: {
          kind: 'paths',
          paths: [{ sourceId: 'settings:config', relativePath: '.hidden/config' }],
        },
      })
      const target = join(repository.root, `directory-ack-${mode}`)
      let interrupted = false
      const input = {
        ...repositoryOptions(repository),
        stagingPath: staged.stagingPath as string,
        targets: [{ sourceId: 'settings:config', targetPath: target }],
        conflictPolicy: 'overwrite' as const,
        dryRun: false,
        directoryAcknowledgementMode: mode,
      }
      const first = await applyStaging({
        ...input,
        afterTargetPublish(_targetPath, entry) {
          if (interrupted || entry.relativePath !== '.') return
          interrupted = true
          throw new Error('lost caller acknowledgement')
        },
      })
      expect(first.state).toBe('failure')
      const resumed = await applyStaging({ ...input, applyId: first.applyId })
      expect(['success', 'partial'], JSON.stringify(resumed)).toContain(resumed.state)
      expect(await readFile(join(target, '.hidden', 'config'), 'utf8')).toBe('saved config')
    }
  })

  it('does not overwrite a target that appears after the worker binds its parent', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'restore-atomic-')))
    roots.push(root)
    const target = join(root, 'target')
    await expect(
      atomicPublish({
        kind: 'file',
        destination: target,
        expected: null,
        payload: 'recovery',
        async beforeCommit() {
          await writeFile(target, 'concurrent')
        },
      }),
    ).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('concurrent')
  })

  it('reconciles a lost success acknowledgement by final content and identity', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'restore-atomic-')))
    roots.push(root)
    const target = join(root, 'target')
    const published = await atomicPublish({
      kind: 'file',
      destination: target,
      expected: null,
      payload: 'recovery',
      acknowledgementMode: 'suppress',
    })
    expect(published.type).toBe('file')
    expect(
      createHash('sha256')
        .update(await readFile(target))
        .digest('hex'),
    ).toBe(createHash('sha256').update('recovery').digest('hex'))
  })

  it('rejects parent-directory replacement before commit', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'restore-parent-aba-')))
    roots.push(root)
    const parent = join(root, 'parent')
    const moved = join(root, 'moved-parent')
    await mkdir(parent)
    const target = join(parent, 'target')
    await expect(
      atomicPublish({
        kind: 'file',
        destination: target,
        expected: null,
        payload: 'recovery',
        async beforeCommit() {
          await rename(parent, moved)
          await mkdir(parent)
        },
      }),
    ).rejects.toThrow()
    expect(await lstatIdentity(target)).toBeNull()
    expect(await lstatIdentity(join(moved, 'target'))).toBeNull()
  })
})

describe('metadata confinement', () => {
  it('does not rebind the sole flags mutation after portable metadata', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'restore-flags-sequence-')))
    roots.push(root)
    const target = join(root, 'target')
    const victim = join(root, 'victim')
    const displaced = join(root, 'displaced')
    await writeFile(target, 'target')
    await writeFile(victim, 'victim')
    const stat = await lstat(target, { bigint: true })
    let swapped = false
    const losses = await restoreMetadata(
      target,
      {
        id: 'entry',
        sourceId: 'source',
        relativePath: 'target',
        type: 'file',
        contentHash: createHash('sha256').update('target').digest('hex'),
        metadata: {
          mode: Number(stat.mode & 0o7777n),
          size: 6,
          modifiedAtNs: stat.mtimeNs.toString(),
          flags: ['hidden'],
        },
      },
      {
        platform: 'darwin',
        async onBeforeCommand() {
          if (swapped) return
          swapped = true
          await rename(target, displaced)
          await link(victim, target)
        },
      },
    )
    expect(swapped).toBe(true)
    expect(losses.map((entry) => entry.code)).toContain('FLAGS_RESTORE_FAILED')
    for (const path of [target, victim, displaced]) {
      const flags = await execFileAsync('/usr/bin/stat', ['-f', '%Sf', '--', path])
      expect(flags.stdout.toLowerCase()).not.toContain('hidden')
    }
    expect(await readFile(target, 'utf8')).toBe('victim')
  })

  it('stops later native mutations when an after-command hook swaps the target', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'restore-metadata-sequence-')))
    roots.push(root)
    const target = join(root, 'target')
    const victim = join(root, 'victim')
    const displaced = join(root, 'displaced')
    await writeFile(target, 'target')
    await writeFile(victim, 'victim')
    const stat = await lstat(target, { bigint: true })
    const firstName = 'com.restore.sequence-first'
    const secondName = 'com.restore.sequence-second'
    let swapped = false
    const losses = await restoreMetadata(
      target,
      {
        id: 'entry',
        sourceId: 'source',
        relativePath: 'target',
        type: 'file',
        contentHash: createHash('sha256').update('target').digest('hex'),
        metadata: {
          mode: Number(stat.mode & 0o7777n),
          size: 6,
          modifiedAtNs: stat.mtimeNs.toString(),
          xattrs: [
            { name: firstName, value: Buffer.from('first').toString('base64') },
            { name: secondName, value: Buffer.from('second').toString('base64') },
          ],
          flags: [],
        },
      },
      {
        platform: 'darwin',
        async onAfterCommand() {
          if (swapped) return
          swapped = true
          await rename(target, displaced)
          await link(victim, target)
        },
      },
    )
    expect(swapped).toBe(true)
    expect(losses.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'XATTR_RESTORE_FAILED',
        'XATTR_RESTORE_SKIPPED',
        'FLAGS_RESTORE_SKIPPED',
      ]),
    )
    for (const name of [firstName, secondName]) {
      await expect(
        execFileAsync('/usr/bin/xattr', ['-p', '-x', '--', name, victim]),
      ).rejects.toThrow()
    }
    const first = await execFileAsync('/usr/bin/xattr', ['-p', '-x', '--', firstName, displaced])
    expect(first.stdout.replace(/\s/g, '').toLowerCase()).toBe('6669727374')
    await expect(
      execFileAsync('/usr/bin/xattr', ['-p', '-x', '--', secondName, displaced]),
    ).rejects.toThrow()
  })

  it('keeps native mutation bound to the held fd during an inner worker race', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'restore-metadata-swap-')))
    roots.push(root)
    const target = join(root, 'target')
    const victim = join(root, 'victim')
    const displaced = join(root, 'displaced')
    await writeFile(target, 'target')
    await writeFile(victim, 'victim')
    const stat = await lstat(target, { bigint: true })
    let boundHookRan = false
    const attributeName = 'com.restore.fd-bound-test'
    const losses = await restoreMetadata(
      target,
      {
        id: 'entry',
        sourceId: 'source',
        relativePath: 'target',
        type: 'file',
        contentHash: createHash('sha256').update('target').digest('hex'),
        metadata: {
          mode: Number(stat.mode & 0o7777n),
          size: 6,
          modifiedAtNs: stat.mtimeNs.toString(),
          xattrs: [{ name: attributeName, value: Buffer.from('bound').toString('base64') }],
          flags: [],
        },
      },
      {
        platform: 'darwin',
        async onNativeFdBound() {
          if (boundHookRan) return
          boundHookRan = true
          await rename(target, displaced)
          await link(victim, target)
        },
      },
    )
    expect(boundHookRan).toBe(true)
    expect(losses.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['XATTR_RESTORE_FAILED', 'FLAGS_RESTORE_SKIPPED']),
    )
    const [targetIdentity, victimIdentity] = await Promise.all([lstat(target), lstat(victim)])
    expect(targetIdentity.ino).toBe(victimIdentity.ino)
    expect(await readFile(target, 'utf8')).toBe('victim')
    await expect(
      execFileAsync('/usr/bin/xattr', ['-p', '-x', '--', attributeName, victim]),
    ).rejects.toThrow()
    const displacedAttribute = await execFileAsync('/usr/bin/xattr', [
      '-p',
      '-x',
      '--',
      attributeName,
      displaced,
    ])
    expect(displacedAttribute.stdout.replace(/\s/g, '').toLowerCase()).toBe('626f756e64')
  })
})

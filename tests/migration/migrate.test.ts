import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCapturePlan } from '../../src/catalog/index.js'
import { type RecoveryPointManifestV1, createV1RecoveryPoint } from '../../src/engine/v1-backup.js'
import { executeV1Retention } from '../../src/engine/v1-retention.js'
import {
  buildLegacyMigrationPointPlan,
  migrateLegacyRepository,
  readLegacyRepository,
} from '../../src/migration/index.js'
import type { PluginManifest } from '../../src/plugin/types.js'
import { initializeRepository, openRepository } from '../../src/repository/index.js'
import { verifyV1Repository } from '../../src/verify/index.js'

const roots: string[] = []
const system = { platform: 'darwin' as const, architecture: 'arm64' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'restore-migrate-'))
  roots.push(root)
  const legacyRepository = join(root, 'legacy', 'RestoreBackup')
  const pointId = '2026-07-18T12-30-45.123'
  const point = join(legacyRepository, pointId)
  await mkdir(join(point, 'Users', 'alice', '.config', 'demo'), { recursive: true })
  await mkdir(join(point, 'Users', 'alice', 'Library', 'Preferences'), { recursive: true })
  await writeFile(join(legacyRepository, '.restore-marker'), 'restore-backup-directory\n')
  await writeFile(join(point, 'Users', 'alice', '.config', 'demo', 'settings.json'), 'settings')
  await writeFile(join(point, 'Users', 'alice', 'Library', 'Preferences', 'demo.plist'), 'plist')
  const target = join(root, 'target')
  await mkdir(target)
  const initialized = await initializeRepository({ targetPath: target, protection: 'plaintext' })
  return { root, legacyRepository, point, pointId, ...initialized }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('legacy v1 migration', () => {
  it('groups exact recoverable paths without root, /Users, or full-home mappings', async () => {
    const value = await fixture()
    const legacy = await readLegacyRepository(value.legacyRepository, { system })
    const point = legacy.points[0]
    if (!point) throw new Error('missing fixture point')
    const plan = buildLegacyMigrationPointPlan(point)

    expect(plan.status).toBe('migratable')
    expect(plan.sources.map((source) => source.declaredPath)).toEqual([
      '/Users/alice/.config',
      '/Users/alice/Library',
    ])
    expect(plan.sources.every((source) => source.declaredPath !== '/Users/alice')).toBe(true)
  })

  it('maps empty leaf directories and explicitly rejects an entirely empty point', async () => {
    const value = await fixture()
    const emptyBranchId = '2026-07-18T12-30-46.123'
    await mkdir(join(value.legacyRepository, emptyBranchId, 'Users', 'alice', '.empty-config'), {
      recursive: true,
    })
    const entirelyEmptyId = '2026-07-18T12-30-47.123'
    await mkdir(join(value.legacyRepository, entirelyEmptyId))
    const legacy = await readLegacyRepository(value.legacyRepository, { system })
    const emptyBranch = legacy.points.find((point) => point.id === emptyBranchId)
    const entirelyEmpty = legacy.points.find((point) => point.id === entirelyEmptyId)
    if (!emptyBranch || !entirelyEmpty) throw new Error('missing empty fixture point')

    const mapped = buildLegacyMigrationPointPlan(emptyBranch)
    const unsupported = buildLegacyMigrationPointPlan(entirelyEmpty)
    expect(mapped).toMatchObject({
      status: 'migratable',
      sources: [{ declaredPath: '/Users/alice/.empty-config' }],
      entries: [{ relativePath: '.', type: 'directory' }],
    })
    expect(unsupported).toMatchObject({
      status: 'unsupported',
      unsupported: [{ code: 'LEGACY_EMPTY_POINT_UNSUPPORTED' }],
    })
  })

  it('dry-runs without points writes, then imports, content-verifies, and reuses provenance', async () => {
    const value = await fixture()
    const before = await readLegacyRepository(value.legacyRepository, { system })
    const options = {
      legacyRepositoryPath: value.legacyRepository,
      repositoryPath: value.repositoryPath,
      expectedRepositoryId: value.repositoryId,
      expectedProtection: value.protection,
      system,
    } as const

    const dryRun = await migrateLegacyRepository(options)
    expect(dryRun.results[0]?.issues).toEqual([])
    expect(dryRun).toMatchObject({
      dryRun: true,
      state: 'success',
      target: { authenticated: true, capabilityChecked: false, lockChecked: false },
      results: [{ state: 'planned', contentVerified: false }],
    })
    expect(await readdir(join(value.repositoryPath, 'points'))).toEqual([])

    const migrated = await migrateLegacyRepository({ ...options, dryRun: false })
    expect(migrated).toMatchObject({
      state: 'success',
      finalRepositoryVerified: true,
      target: { capabilityChecked: true, lockChecked: true },
      results: [{ state: 'imported', contentVerified: true }],
    })
    const pointId = migrated.results[0]?.targetPointId
    expect(pointId).toBeTruthy()
    if (!pointId) throw new Error('missing migrated point')
    const verified = await verifyV1Repository({
      repositoryPath: value.repositoryPath,
      expectedRepositoryId: value.repositoryId,
      expectedProtection: value.protection,
      selector: { kind: 'point', pointId },
      scope: 'content',
    })
    expect(verified).toMatchObject({ state: 'success', filesVerified: 2 })

    const repeated = await migrateLegacyRepository({ ...options, dryRun: false })
    expect(repeated.results[0]).toMatchObject({
      state: 'already-imported',
      targetPointId: pointId,
      contentVerified: true,
    })
    const after = await readLegacyRepository(value.legacyRepository, { system })
    expect(after.digest).toBe(before.digest)
    expect(after.identityDigest).toBe(before.identityDigest)
  }, 15_000)

  it('leaves interrupted pending state invisible and retries with a deterministic suffix', async () => {
    const value = await fixture()
    const legacy = await readLegacyRepository(value.legacyRepository, { system })
    const point = legacy.points[0]
    if (!point) throw new Error('missing fixture point')
    const plan = buildLegacyMigrationPointPlan(point)
    for (let attempt = 0; attempt < 17; attempt++) {
      const pointId = attempt === 0 ? plan.targetPointId : `${plan.targetPointId}-r${attempt}`
      await mkdir(join(value.repositoryPath, 'points', `${pointId}.pending`))
    }

    const result = await migrateLegacyRepository({
      legacyRepositoryPath: value.legacyRepository,
      repositoryPath: value.repositoryPath,
      expectedRepositoryId: value.repositoryId,
      expectedProtection: value.protection,
      system,
      dryRun: false,
    })

    expect(result.results[0]?.issues).toEqual([])

    expect(result.results[0]).toMatchObject({
      state: 'imported',
      targetPointId: `${plan.targetPointId}-r17`,
      contentVerified: true,
    })
    expect(result.finalRepositoryVerified).toBe(true)
  })

  it('rejects a healthy existing point whose authenticated entries do not match legacy provenance', async () => {
    const value = await fixture()
    const legacy = await readLegacyRepository(value.legacyRepository, { system })
    const legacyPoint = legacy.points[0]
    if (!legacyPoint) throw new Error('missing fixture point')
    const migrationPlan = buildLegacyMigrationPointPlan(legacyPoint)
    const unrelated = join(value.root, 'unrelated')
    await writeFile(unrelated, 'different')
    const plugin: PluginManifest = {
      name: 'unrelated',
      description: 'unrelated',
      paths: [unrelated],
      sources: [
        {
          name: 'source',
          path: unrelated,
          requirement: 'required',
          sensitivity: 'private',
          expectedType: 'file',
          recoveryScope: 'exact',
        },
      ],
    }
    const created = await createV1RecoveryPoint({
      repositoryPath: value.repositoryPath,
      expectedRepositoryId: value.repositoryId,
      expectedProtection: value.protection,
      plan: buildCapturePlan([plugin]),
      pointId: migrationPlan.targetPointId,
      now: () => new Date(legacyPoint.createdAt),
    })
    expect(created.state).toBe('success')

    const result = await migrateLegacyRepository({
      legacyRepositoryPath: value.legacyRepository,
      repositoryPath: value.repositoryPath,
      expectedRepositoryId: value.repositoryId,
      expectedProtection: value.protection,
      system,
      dryRun: false,
    })

    expect(result).toMatchObject({
      state: 'failure',
      results: [{ issues: [{ code: 'MIGRATION_PROVENANCE_MISMATCH' }] }],
    })
  })

  it('rejects a canonical target nested in the legacy source through a parent alias', async () => {
    const value = await fixture()
    const nestedTarget = join(value.point, 'nested-target')
    await mkdir(nestedTarget)
    const nested = await initializeRepository({ targetPath: nestedTarget, protection: 'plaintext' })
    const alias = join(value.root, 'target-alias')
    await symlink(nestedTarget, alias)

    const result = await migrateLegacyRepository({
      legacyRepositoryPath: value.legacyRepository,
      repositoryPath: join(alias, 'RestoreBackup'),
      expectedRepositoryId: nested.repositoryId,
      expectedProtection: nested.protection,
      system,
      dryRun: false,
    })

    expect(result).toMatchObject({
      state: 'failure',
      category: 'destination',
      results: [{ issues: [{ code: 'MIGRATION_TARGET_OVERLAPS_SOURCE' }] }],
    })
  })

  it('freezes and read-verifies staging, cleans an interruption, and retries without poisoning the point id', async () => {
    const value = await fixture()
    const options = {
      legacyRepositoryPath: value.legacyRepository,
      repositoryPath: value.repositoryPath,
      expectedRepositoryId: value.repositoryId,
      expectedProtection: value.protection,
      system,
      dryRun: false,
    } as const
    let stagedRoot = ''
    const interrupted = await migrateLegacyRepository(options, {
      async beforeMaterializedCapture(root) {
        stagedRoot = root
        await expect(
          writeFile(join(root, '001', 'demo', 'settings.json'), 'tampered'),
        ).rejects.toMatchObject({ code: 'EACCES' })
        throw new Error('simulated interruption after staging verification')
      },
    })

    expect(interrupted).toMatchObject({ state: 'failure', results: [{ state: 'failure' }] })
    expect(await readdir(join(value.repositoryPath, 'points'))).toEqual([])
    await expect(stat(stagedRoot)).rejects.toMatchObject({ code: 'ENOENT' })

    const retried = await migrateLegacyRepository(options)
    expect(retried).toMatchObject({
      state: 'success',
      finalRepositoryVerified: true,
      results: [{ state: 'imported', contentVerified: true }],
    })
  }, 20_000)

  it('serializes authenticated legacy 0600/0700 mode and mtime instead of frozen staging metadata', async () => {
    const value = await fixture()
    const directory = join(value.point, 'Users', 'alice', '.config', 'demo')
    const file = join(directory, 'settings.json')
    await chmod(directory, 0o700)
    await chmod(file, 0o600)
    const legacy = await readLegacyRepository(value.legacyRepository, { system })
    const point = legacy.points[0]
    if (!point) throw new Error('missing legacy point')
    const expectedPlan = buildLegacyMigrationPointPlan(point)

    const migrated = await migrateLegacyRepository({
      legacyRepositoryPath: value.legacyRepository,
      repositoryPath: value.repositoryPath,
      expectedRepositoryId: value.repositoryId,
      expectedProtection: value.protection,
      system,
      dryRun: false,
    })
    const targetPointId = migrated.results[0]?.targetPointId
    if (!targetPointId) throw new Error('missing target point')
    const repository = await openRepository(value.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: value.repositoryId,
      expectedProtection: value.protection,
    })
    let protectedManifest: Buffer | undefined
    let plaintext: Buffer | undefined
    try {
      if (!repository.protector) throw new Error('missing repository protector')
      protectedManifest = await readFile(
        join(repository.layout.points, targetPointId, 'manifest.json'),
      )
      plaintext = await repository.protector.open(protectedManifest, {
        repositoryId: value.repositoryId,
        purpose: 'manifest',
        objectId: targetPointId,
      })
      const manifest = JSON.parse(plaintext.toString('utf8')) as RecoveryPointManifestV1
      for (const relativePath of ['demo', 'demo/settings.json']) {
        const expected = expectedPlan.entries.find((entry) => entry.relativePath === relativePath)
        const actual = manifest.entries.find((entry) => entry.relativePath === relativePath)
        expect(actual?.metadata).toEqual({
          mode: relativePath === 'demo' ? 0o700 : 0o600,
          size: expected?.size,
          modifiedAtNs: expected?.modifiedAtNs,
        })
        expect(actual?.metadata).not.toHaveProperty('createdAtNs')
        expect(actual?.metadata).not.toHaveProperty('xattrs')
        expect(actual?.metadata).not.toHaveProperty('flags')
      }
    } finally {
      protectedManifest?.fill(0)
      plaintext?.fill(0)
      repository.close()
    }
    expect(migrated).toMatchObject({ state: 'success', finalRepositoryVerified: true })
  }, 20_000)

  it('holds one lease across migration so backup, retention, and a second migration fail with stable contention', async () => {
    const value = await fixture()
    const options = {
      legacyRepositoryPath: value.legacyRepository,
      repositoryPath: value.repositoryPath,
      expectedRepositoryId: value.repositoryId,
      expectedProtection: value.protection,
      system,
      dryRun: false,
    } as const
    let signalEntered: (() => void) | undefined
    const entered = new Promise<void>((resolveEntered) => {
      signalEntered = resolveEntered
    })
    let continueMigration: (() => void) | undefined
    const gate = new Promise<void>((resolveGate) => {
      continueMigration = resolveGate
    })
    const first = migrateLegacyRepository(options, {
      async beforeMaterializedCapture() {
        signalEntered?.()
        await gate
      },
    })
    await entered

    const competingSource = join(value.root, 'competing-source')
    await writeFile(competingSource, 'content')
    const competingBackup = await createV1RecoveryPoint({
      repositoryPath: value.repositoryPath,
      expectedRepositoryId: value.repositoryId,
      expectedProtection: value.protection,
      plan: buildCapturePlan([
        {
          name: 'competing',
          description: 'competing writer',
          paths: [competingSource],
          sources: [
            {
              name: 'source',
              path: competingSource,
              requirement: 'required',
              sensitivity: 'private',
              expectedType: 'file',
              recoveryScope: 'exact',
            },
          ],
        },
      ]),
      pointId: 'competing-backup',
    })
    expect(competingBackup).toMatchObject({
      state: 'failure',
      category: 'lock',
      issues: [{ code: 'REPOSITORY_LOCKED' }],
    })

    const retention = await executeV1Retention({
      repositoryPath: value.repositoryPath,
      expectedRepositoryId: value.repositoryId,
      expectedProtection: value.protection,
      healthyRetention: 1,
      dryRun: false,
    })
    expect(retention).toMatchObject({
      state: 'failure',
      category: 'lock',
      issues: [{ code: 'REPOSITORY_LOCKED' }],
    })

    const second = await migrateLegacyRepository(options)
    expect(second).toMatchObject({
      state: 'failure',
      category: 'lock',
      results: [{ issues: [{ code: 'REPOSITORY_LOCKED' }] }],
    })

    continueMigration?.()
    expect(await first).toMatchObject({ state: 'success', finalRepositoryVerified: true })
  }, 30_000)
})

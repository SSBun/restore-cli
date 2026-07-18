import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectLegacyRepository,
  listLegacyRecoveryPoints,
  readLegacyRepository,
  restoreLegacyRecoveryPoint,
} from '../../src/migration/index.js'

const roots: string[] = []
const system = { platform: 'darwin' as const, architecture: 'arm64' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'restore-legacy-'))
  roots.push(root)
  const repository = join(root, 'legacy', 'RestoreBackup')
  const point = join(repository, '2026-07-18T12-30-45.123')
  await mkdir(join(point, 'Users', 'alice', '.config', 'demo'), { recursive: true })
  await writeFile(join(repository, '.restore-marker'), 'restore-backup-directory\n')
  await writeFile(join(point, 'Users', 'alice', '.config', 'demo', 'settings.json'), '{"ok":true}')
  return { root, repository, point, pointId: '2026-07-18T12-30-45.123' }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('strict legacy 0.1.x reader', () => {
  it('detects, describes, and lists complete points without modifying source identity', async () => {
    const value = await fixture()
    const detected = await detectLegacyRepository(value.repository, { system })
    const listed = await listLegacyRecoveryPoints(value.repository, { system })
    const after = await readLegacyRepository(value.repository, { system })

    expect(detected).toMatchObject({
      format: 'restore-legacy-0.1.x',
      readOnly: true,
      points: [{ id: value.pointId, fileCount: 1, migratable: true }],
    })
    expect(listed).toHaveLength(1)
    expect(after.digest).toBe(detected?.digest)
    expect(after.identityDigest).toBe(detected?.identityDigest)
  })

  it('returns null for a non-legacy directory and reports unsafe legacy entries explicitly', async () => {
    const value = await fixture()
    const ordinary = join(value.root, 'ordinary')
    await mkdir(ordinary)
    expect(await detectLegacyRepository(ordinary, { system })).toBeNull()

    await symlink(
      '/etc/passwd',
      join(value.pointId ? value.repository : '', value.pointId, 'Users', 'alice', 'escape'),
    )
    await mkdir(join(value.repository, 'unexpected.in-progress'))
    const descriptor = await readLegacyRepository(value.repository, { system })

    expect(descriptor.points[0]).toMatchObject({ migratable: false })
    expect(descriptor.points[0]?.unsupported).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'LEGACY_SYMLINK_ESCAPE' })]),
    )
    expect(descriptor.unsupported).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'LEGACY_INCOMPLETE_POINT' })]),
    )
  })

  it('rejects unsupported platforms before touching the source', async () => {
    const value = await fixture()
    await expect(
      readLegacyRepository(value.repository, {
        system: { platform: 'linux', architecture: 'x64' },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' })
  })

  it('rejects a symlinked repository root and non-emitted timestamp names', async () => {
    const value = await fixture()
    const alias = join(value.root, 'legacy-alias')
    await symlink(value.repository, alias)
    expect(await detectLegacyRepository(alias, { system })).toBeNull()

    await mkdir(join(value.repository, '2026-02-30T12-30-45.123'))
    await mkdir(join(value.repository, '2026-07-18T12-30-45.1'))
    await mkdir(join(value.repository, '2026-07-18T12-30-45.1234'))
    const descriptor = await readLegacyRepository(value.repository, { system })
    expect(descriptor.points.map((point) => point.id)).toEqual([value.pointId])
    expect(
      descriptor.unsupported.filter((entry) => entry.code === 'LEGACY_UNKNOWN_ROOT_ENTRY'),
    ).toHaveLength(3)
  })

  it('rejects a directory swapped away and back while a bound scan is starting', async () => {
    const value = await fixture()
    const target = await realpath(join(value.point, 'Users', 'alice', '.config', 'demo'))
    const displaced = `${target}.displaced`
    let swapped = false
    let restorePath: Promise<void> | undefined

    const read = readLegacyRepository(value.repository, {
      system,
      async beforeDirectoryScan(path) {
        if (swapped || path !== target) return
        swapped = true
        await rename(target, displaced)
        await mkdir(target)
        await writeFile(join(target, 'settings.json'), '{"replacement":true}')
        restorePath = new Promise((resolveRestore, rejectRestore) => {
          setTimeout(() => {
            void (async () => {
              await rm(target, { recursive: true, force: true })
              await rename(displaced, target)
            })().then(resolveRestore, rejectRestore)
          }, 0)
        })
      },
    })

    await expect(read).rejects.toMatchObject({ code: 'LEGACY_SOURCE_CHANGED' })
    await restorePath
    expect(await readFile(join(target, 'settings.json'), 'utf8')).toBe('{"ok":true}')
  })
})

describe('legacy restore', () => {
  it('requires a matching dry-run digest and atomically copies only to an explicit destination', async () => {
    const value = await fixture()
    const destination = join(value.root, 'restore-staging')
    await mkdir(destination)
    const before = await readLegacyRepository(value.repository, { system })
    const dryRun = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
    })

    expect(dryRun).toMatchObject({
      dryRun: true,
      state: 'success',
      filesRestored: 0,
      destination: { overwrite: false, deletes: false, atomicFiles: true },
    })

    const denied = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
      dryRun: false,
    })
    expect(denied).toMatchObject({
      state: 'failure',
      issues: [{ code: 'LEGACY_RESTORE_DRY_RUN_REQUIRED' }],
    })

    const restored = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
      dryRun: false,
      approvedPlanDigest: dryRun.planDigest,
    })
    expect(restored).toMatchObject({ state: 'success', filesRestored: 1 })
    expect(
      await readFile(
        join(destination, 'Users', 'alice', '.config', 'demo', 'settings.json'),
        'utf8',
      ),
    ).toBe('{"ok":true}')
    const after = await readLegacyRepository(value.repository, { system })
    expect(after.digest).toBe(before.digest)
    expect(after.identityDigest).toBe(before.identityDigest)
  })

  it('never overwrites existing destination content', async () => {
    const value = await fixture()
    const destination = join(value.root, 'restore-staging')
    const existing = join(destination, 'Users', 'alice', '.config', 'demo', 'settings.json')
    await mkdir(join(existing, '..'), { recursive: true })
    await writeFile(existing, 'keep me')
    const dryRun = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
    })
    const result = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
      dryRun: false,
      approvedPlanDigest: dryRun.planDigest,
    })

    expect(result).toMatchObject({
      state: 'failure',
      issues: [{ code: 'RESTORE_DESTINATION_CONFLICT' }],
    })
    expect(await readFile(existing, 'utf8')).toBe('keep me')
  })

  it('invalidates approval when a same-content legacy file is replaced', async () => {
    const value = await fixture()
    const destination = join(value.root, 'restore-staging')
    await mkdir(destination)
    const dryRun = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
    })
    const source = join(value.point, 'Users', 'alice', '.config', 'demo', 'settings.json')
    const metadata = await stat(source)
    const replacement = `${source}.replacement`
    await writeFile(replacement, '{"ok":true}', { mode: metadata.mode })
    await utimes(replacement, metadata.atime, metadata.mtime)
    await rename(replacement, source)

    const denied = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
      dryRun: false,
      approvedPlanDigest: dryRun.planDigest,
    })

    expect(denied).toMatchObject({
      state: 'failure',
      issues: [{ code: 'LEGACY_RESTORE_DRY_RUN_REQUIRED' }],
    })
    expect(dryRun.source.repositoryIdentityDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not publish through a parent path replaced after the atomic worker binds it', async () => {
    const value = await fixture()
    const destination = join(value.root, 'restore-staging')
    await mkdir(destination)
    const dryRun = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
    })
    let displaced = ''
    const result = await restoreLegacyRecoveryPoint(
      {
        legacyRepositoryPath: value.repository,
        pointId: value.pointId,
        destinationPath: destination,
        system,
        dryRun: false,
        approvedPlanDigest: dryRun.planDigest,
      },
      {
        async beforeDestinationCommit(file) {
          const parent = dirname(file.destinationPath)
          displaced = `${parent}.displaced`
          await rename(parent, displaced)
          await mkdir(parent)
        },
      },
    )

    expect(result).toMatchObject({
      state: 'failure',
      issues: [{ code: 'RESTORE_DESTINATION_CHANGED' }],
    })
    expect(await readdir(dirname(result.files[0]?.destinationPath ?? destination))).toEqual([])
    expect(await readdir(displaced)).toEqual([])
  })

  it('invalidates approval when the explicit destination root is replaced', async () => {
    const value = await fixture()
    const destination = join(value.root, 'restore-staging')
    await mkdir(destination)
    const dryRun = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
    })
    await rename(destination, `${destination}.approved`)
    await mkdir(destination)

    const denied = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
      dryRun: false,
      approvedPlanDigest: dryRun.planDigest,
    })

    expect(denied).toMatchObject({
      state: 'failure',
      issues: [{ code: 'LEGACY_RESTORE_DRY_RUN_REQUIRED' }],
    })
    expect(await readdir(destination)).toEqual([])
  })

  it('resumes a multi-file interruption by reconciling exact published content', async () => {
    const value = await fixture()
    await writeFile(join(value.point, 'Users', 'alice', '.config', 'demo', 'second.json'), 'second')
    const destination = join(value.root, 'restore-staging')
    await mkdir(destination)
    const dryRun = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
    })
    let commits = 0
    const interrupted = await restoreLegacyRecoveryPoint(
      {
        legacyRepositoryPath: value.repository,
        pointId: value.pointId,
        destinationPath: destination,
        system,
        dryRun: false,
        approvedPlanDigest: dryRun.planDigest,
      },
      {
        beforeDestinationCommit() {
          commits++
          if (commits === 2) throw new Error('simulated interruption')
        },
      },
    )
    expect(interrupted).toMatchObject({ state: 'failure', filesRestored: 1 })

    const resumed = await restoreLegacyRecoveryPoint({
      legacyRepositoryPath: value.repository,
      pointId: value.pointId,
      destinationPath: destination,
      system,
      dryRun: false,
      approvedPlanDigest: dryRun.planDigest,
    })
    expect(resumed).toMatchObject({
      state: 'success',
      filesRestored: 2,
      counts: { filesWritten: 1, filesSkipped: 1 },
      verificationScope: 'content',
    })
  })
})

import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCapturePlan } from '../../src/catalog/index.js'
import { createV1RecoveryPoint } from '../../src/engine/v1-backup.js'
import type { PluginManifest } from '../../src/plugin/types.js'
import { stageRecovery } from '../../src/recovery/index.js'
import { initializeRepository } from '../../src/repository/index.js'

const roots: string[] = []
const now = () => new Date('2026-07-19T00:00:00.000Z')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function repositoryWithDirectorySource(source: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'restore-stage-overlap-')))
  roots.push(root)
  const target = join(root, 'repository-target')
  await mkdir(target)
  const initialized = await initializeRepository({
    targetPath: target,
    protection: 'plaintext',
    now,
  })
  const plugin: PluginManifest = {
    name: 'settings',
    description: 'overlap fixture',
    paths: [source],
    sources: [
      {
        name: 'config',
        path: source,
        requirement: 'required',
        sensitivity: 'private',
        expectedType: 'directory',
        recoveryScope: 'exact',
      },
    ],
  }
  const backup = await createV1RecoveryPoint({
    repositoryPath: initialized.repositoryPath,
    expectedRepositoryId: initialized.repositoryId,
    expectedProtection: 'plaintext',
    pointId: 'point',
    plan: buildCapturePlan([plugin]),
    now,
  })
  expect(backup.state).toBe('success')
  return { root, ...initialized }
}

async function rejected(
  repository: Awaited<ReturnType<typeof repositoryWithDirectorySource>>,
  stagingRoot: string,
) {
  return stageRecovery({
    repositoryPath: repository.repositoryPath,
    expectedRepositoryId: repository.repositoryId,
    expectedProtection: 'plaintext',
    pointId: 'point',
    stagingRoot,
    rejectOriginalPathOverlap: true,
  })
}

describe('staging original-path overlap preflight', () => {
  it('rejects a staging descendant before creating any staging child', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'restore-overlap-source-')))
    roots.push(root)
    const source = join(root, 'source')
    const staging = join(source, 'staging')
    await mkdir(source)
    await mkdir(staging)
    await writeFile(join(source, 'config'), 'saved')
    const repository = await repositoryWithDirectorySource(source)
    const before = await readdir(staging)
    const result = await rejected(repository, staging)
    expect(result).toMatchObject({ state: 'failure', category: 'destination' })
    expect(result.issues[0]?.code).toBe('STAGING_ORIGINAL_PATH_OVERLAP')
    expect(await readdir(staging)).toEqual(before)
  })

  it('rejects a source descendant without adding staging control children', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'restore-overlap-staging-')))
    roots.push(root)
    const staging = join(root, 'staging')
    const source = join(staging, 'source')
    await mkdir(staging)
    await mkdir(source)
    await writeFile(join(source, 'config'), 'saved')
    const repository = await repositoryWithDirectorySource(source)
    const before = await readdir(staging)
    const result = await rejected(repository, staging)
    expect(result.issues[0]?.code).toBe('STAGING_ORIGINAL_PATH_OVERLAP')
    expect(await readdir(staging)).toEqual(before)
  })

  it('uses the canonical staging target when the requested root is a symlink', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'restore-overlap-link-')))
    roots.push(root)
    const source = join(root, 'source')
    const staging = join(source, 'staging')
    const alias = join(root, 'staging-alias')
    await mkdir(source)
    await mkdir(staging)
    await writeFile(join(source, 'config'), 'saved')
    await symlink(staging, alias)
    const repository = await repositoryWithDirectorySource(source)
    const result = await rejected(repository, alias)
    expect(result.issues[0]?.code).toBe('STAGING_ORIGINAL_PATH_OVERLAP')
    expect(await readdir(staging)).toEqual([])
  })
})

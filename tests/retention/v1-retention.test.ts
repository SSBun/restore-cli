import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCapturePlan } from '../../src/catalog/index.js'
import { createV1RecoveryPoint } from '../../src/engine/v1-backup.js'
import {
  deleteV1PointSafely,
  executeV1Retention,
  planV1Retention,
} from '../../src/engine/v1-retention.js'
import type { PluginManifest } from '../../src/plugin/types.js'
import {
  acquireRepositoryLock,
  initializeRepository,
  openRepository,
} from '../../src/repository/index.js'
import { discoverVisiblePoints } from '../../src/verify/index.js'

const roots: string[] = []

function point(index: number, health: 'healthy' | 'partial' | 'failed' = 'healthy') {
  return {
    id: `point-${String(index).padStart(2, '0')}`,
    completedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    health,
    estimatedBytes: index + 1,
    protected: false,
  } as const
}

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'restore-retention-'))
  roots.push(root)
  const initialized = await initializeRepository({ targetPath: root, protection: 'plaintext' })
  const source = join(root, 'source')
  await writeFile(source, 'content')
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
  const plan = buildCapturePlan([plugin])
  for (let index = 0; index < 3; index++) {
    await createV1RecoveryPoint({
      repositoryPath: initialized.repositoryPath,
      expectedRepositoryId: initialized.repositoryId,
      expectedProtection: 'plaintext',
      plan,
      pointId: `point-${index}`,
      now: () => new Date(Date.UTC(2026, 0, index + 1)),
    })
  }
  return initialized
}

async function treeDigest(path: string): Promise<string> {
  const lines: string[] = []
  async function visit(current: string, prefix = ''): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        lines.push(`d:${relative}`)
        await visit(full, relative)
      } else if (entry.isSymbolicLink()) lines.push(`l:${relative}`)
      else
        lines.push(
          `f:${relative}:${createHash('sha256')
            .update(await readFile(full))
            .digest('hex')}`,
        )
    }
  }
  await visit(path)
  return lines.join('\n')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('pure v1 retention plan', () => {
  it('removes exactly the oldest of 15 healthy points', () => {
    const plan = planV1Retention(
      Array.from({ length: 15 }, (_, index) => point(index)),
      14,
    )
    expect(plan.removed.map((entry) => entry.id)).toEqual(['point-00'])
  })

  it('does not count partial points or delete the last healthy point', () => {
    expect(planV1Retention([point(0), point(1, 'partial')], 1).removed).toEqual([])
    expect(
      planV1Retention([point(0), point(1, 'partial'), point(2, 'failed')], 14).removed,
    ).toEqual([])
  })

  it('keeps protected Safety Points without consuming recent healthy slots', () => {
    const protectedPoint = { ...point(15), protected: true }
    const plan = planV1Retention(
      [...Array.from({ length: 15 }, (_, index) => point(index)), protectedPoint],
      14,
    )
    expect(plan.kept.filter((entry) => entry.health === 'healthy')).toHaveLength(15)
    expect(plan.removed.map((entry) => entry.id)).toEqual(['point-00'])
    expect(plan.kept.find((entry) => entry.id === protectedPoint.id)?.reason).toBe(
      'protected-safety-point',
    )
  })
})

describe('v1 retention execution', () => {
  it('keeps dry-run byte-for-byte unchanged and executes the same selected set', async () => {
    const repository = await repositoryFixture()
    const options = {
      repositoryPath: repository.repositoryPath,
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: 'plaintext' as const,
      healthyRetention: 2,
    }
    const before = await treeDigest(repository.repositoryPath)
    const dryRun = await executeV1Retention({ ...options, dryRun: true })
    expect(await treeDigest(repository.repositoryPath)).toBe(before)
    const execute = await executeV1Retention({ ...options, dryRun: false })
    expect(dryRun.removed.map((entry) => entry.id)).toEqual(
      execute.removed.map((entry) => entry.id),
    )
    expect(execute.deletedPointIds).toEqual(['point-0'])
  }, 20_000)

  it('detects point drift before deletion', async () => {
    const repository = await repositoryFixture()
    const result = await executeV1Retention({
      repositoryPath: repository.repositoryPath,
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: 'plaintext',
      healthyRetention: 2,
      dryRun: false,
      async beforeDriftCheck() {
        await rename(
          join(repository.repositoryPath, 'points', 'point-0'),
          join(repository.repositoryPath, 'points', 'point-0.pending'),
        )
      },
    })
    expect(result).toMatchObject({ state: 'failure', category: 'integrity', deletedPointIds: [] })
    expect(result.issues.map((entry) => entry.code)).toContain('RETENTION_POINT_DRIFT')
  })

  it('reports deletion failure and still releases the exclusive lock', async () => {
    const repository = await repositoryFixture()
    let released = false
    const result = await executeV1Retention({
      repositoryPath: repository.repositoryPath,
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: 'plaintext',
      healthyRetention: 2,
      dryRun: false,
      async acquireLock(handle, operation) {
        const lock = await acquireRepositoryLock(handle, operation)
        return {
          metadata: lock.metadata,
          async release() {
            await lock.release()
            released = true
          },
        }
      },
      async deletePoint() {
        throw new Error('injected deletion failure')
      },
    })
    expect(result.state).toBe('degraded')
    expect(result.issues.map((entry) => entry.code)).toContain('RETENTION_DELETE_FAILED')
    expect(released).toBe(true)
  })

  it('survives an active nested-link race without deleting outside or sibling points', async () => {
    const repository = await repositoryFixture()
    const outside = join(repository.repositoryPath, '..', 'outside-retention')
    await mkdir(outside)
    const sentinel = join(outside, 'sentinel')
    await writeFile(sentinel, 'keep')
    const handle = await openRepository(repository.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: 'plaintext',
    })
    try {
      const selected = (await discoverVisiblePoints(handle)).points.find(
        (entry) => entry.id === 'point-0',
      )
      if (!selected) throw new Error('missing point')
      const sibling = join(repository.repositoryPath, 'points', 'point-1')
      await deleteV1PointSafely(handle, selected, {
        async onCwdBound(quarantinePath) {
          await rename(join(quarantinePath, 'blobs'), join(quarantinePath, 'blobs-original'))
          await symlink(outside, join(quarantinePath, 'blobs'))
          await symlink(sibling, join(quarantinePath, 'sibling-link'))
        },
      })
      expect(await readFile(sentinel, 'utf8')).toBe('keep')
      expect(await readFile(join(sibling, 'point.json'), 'utf8')).toContain('point-1')
    } finally {
      handle.close()
    }
  })
})

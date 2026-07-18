import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCapturePlan } from '../../src/catalog/index.js'
import { createV1RecoveryPoint } from '../../src/engine/v1-backup.js'
import { getV1Status } from '../../src/engine/v1-stat.js'
import type { PluginManifest } from '../../src/plugin/types.js'
import { initializeRepository } from '../../src/repository/index.js'
import { verifyV1Repository } from '../../src/verify/index.js'
import type { VerificationCoverage, VerificationReport } from '../../src/verify/index.js'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'restore-status-'))
  roots.push(root)
  const repository = await initializeRepository({ targetPath: root, protection: 'plaintext' })
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
  await createV1RecoveryPoint({
    repositoryPath: repository.repositoryPath,
    expectedRepositoryId: repository.repositoryId,
    expectedProtection: 'plaintext',
    plan: buildCapturePlan([plugin]),
    pointId: 'healthy',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  })
  return repository
}

function options(repository: Awaited<ReturnType<typeof fixture>>, now: string) {
  return {
    repositoryPath: repository.repositoryPath,
    expectedRepositoryId: repository.repositoryId,
    expectedProtection: 'plaintext' as const,
    schedulerIntervalHours: 12,
    schedulerRunning: true,
    now: () => new Date(now),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v1 repository status', () => {
  it('degrades only after, not at, the 24-hour RPO boundary', async () => {
    const repository = await fixture()
    const boundary = await getV1Status(options(repository, '2026-01-02T00:00:00.000Z'))
    const stale = await getV1Status(options(repository, '2026-01-02T00:00:00.001Z'))
    expect(boundary.rpo).toMatchObject({ ageMs: 86_400_000, degraded: false })
    expect(stale.rpo.degraded).toBe(true)
    expect(boundary.recoveryPoints).toMatchObject({
      healthy: 1,
      partial: 0,
      failed: 0,
      latestId: 'healthy',
      latestHealthyId: 'healthy',
    })
    expect(boundary.verification).toEqual({ structural: null, content: null })
    expect(boundary.target.capabilities).toEqual({
      readable: true,
      writeChecked: false,
      writable: null,
      readback: null,
      atomicRename: null,
    })
  })

  it('handles malformed history and visible points as explicit diagnostics', async () => {
    const repository = await fixture()
    await writeFile(join(repository.repositoryPath, 'operations', 'bad.json'), '{')
    await writeFile(join(repository.repositoryPath, 'points', 'broken'), 'not a point directory')
    const status = await getV1Status(options(repository, '2026-01-01T01:00:00.000Z'))
    expect(status.recoveryPoints).toMatchObject({ healthy: 1, failed: 1 })
    expect(status.recentOperations).toEqual([])
    expect(status.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['INVALID_OPERATION_HISTORY', 'RECOVERY_POINT_FAILURES']),
    )
  })

  it('keeps integrity authoritative for a newer partial point plus malformed residue', async () => {
    const repository = await fixture()
    const present = join(repository.repositoryPath, '..', 'partial-present')
    const missing = join(repository.repositoryPath, '..', 'partial-missing')
    await writeFile(present, 'present')
    const consistencyGroup = 'mixed-status'
    const plugin: PluginManifest = {
      name: 'partial',
      description: 'partial point',
      paths: [present, missing],
      sources: [
        {
          name: 'present',
          path: present,
          requirement: 'optional',
          sensitivity: 'private',
          expectedType: 'file',
          recoveryScope: 'exact',
          consistencyGroup,
        },
        {
          name: 'missing',
          path: missing,
          requirement: 'optional',
          sensitivity: 'private',
          expectedType: 'file',
          recoveryScope: 'exact',
          consistencyGroup,
        },
      ],
    }
    await createV1RecoveryPoint({
      repositoryPath: repository.repositoryPath,
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: 'plaintext',
      plan: buildCapturePlan([plugin]),
      pointId: 'newer-partial',
      now: () => new Date('2026-01-02T00:00:00.000Z'),
    })
    await writeFile(join(repository.repositoryPath, 'points', 'malformed'), 'not a point')

    const status = await getV1Status(options(repository, '2026-01-02T01:00:00.000Z'))

    expect(status).toMatchObject({ state: 'failure', category: 'integrity' })
    expect(status.recoveryPoints).toMatchObject({ healthy: 1, partial: 1, failed: 1 })
    expect(status.issues[0]?.category).toBe('integrity')
  })

  it('derives point identity and counts from the authenticated verification snapshot', async () => {
    const repository = await fixture()
    const snapshot = await verifyV1Repository({
      repositoryPath: repository.repositoryPath,
      expectedRepositoryId: repository.repositoryId,
      expectedProtection: 'plaintext',
      selector: { kind: 'all' },
      scope: 'structural',
    })
    const report: VerificationReport = {
      ...snapshot,
      resolvedPointIds: ['snapshot-point'],
      resolvedPointId: 'snapshot-point',
      points: snapshot.points.map((point) => ({ ...point, pointId: 'snapshot-point' })),
    }
    const status = await getV1Status({
      ...options(repository, '2026-01-01T01:00:00.000Z'),
      verify: async () => report,
    })
    expect(status.recoveryPoints).toMatchObject({
      latestId: 'snapshot-point',
      latestHealthyId: 'snapshot-point',
      healthy: 1,
    })
  })

  it('propagates a sanitized zero-point verification failure ahead of RPO status', async () => {
    const repository = await fixture()
    const coverage: VerificationCoverage = {
      pointsConsidered: 0,
      pointsVerified: 0,
      pointsSkipped: 0,
      pointsFailed: 0,
      filesConsidered: 0,
      filesVerified: 0,
      filesSkipped: 0,
      filesFailed: 0,
      bytesConsidered: 0,
      bytesVerified: 0,
      bytesSkipped: 0,
      bytesFailed: 0,
      complete: false,
    }
    const report: VerificationReport = {
      operation: 'verify',
      scope: 'structural',
      verificationScope: 'structural',
      selector: { kind: 'all' },
      resolvedPointIds: [],
      resolvedPointId: null,
      repositoryId: repository.repositoryId,
      protection: 'plaintext',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      cost: 'low',
      state: 'failure',
      category: 'integrity',
      ...coverage,
      coverage,
      points: [],
      issues: [
        {
          code: 'POINT_DISCOVERY_FAILED',
          category: 'integrity',
          message: 'sensitive path /private/example',
          nextAction: 'unsafe raw detail',
        },
      ],
      nextAction: 'unsafe raw detail',
    }
    const status = await getV1Status({
      ...options(repository, '2026-01-01T01:00:00.000Z'),
      verify: async () => report,
    })
    expect(status).toMatchObject({ state: 'failure', category: 'integrity' })
    expect(status.issues[0]?.code).toBe('POINT_DISCOVERY_FAILED')
    expect(status.issues.map((issue) => issue.code)).toContain('RPO_DEGRADED')
    expect(JSON.stringify(status)).not.toContain('/private/example')
    expect(JSON.stringify(status)).not.toContain('unsafe raw detail')
  })
})

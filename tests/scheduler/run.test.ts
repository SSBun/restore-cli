import { describe, expect, it, vi } from 'vitest'
import type { ResolvedBackupConfiguration } from '../../src/config/loader.js'
import type { createV1RecoveryPoint } from '../../src/engine/v1-backup.js'
import type { getV1Status } from '../../src/engine/v1-stat.js'
import type { preparePlugins } from '../../src/plugin/prepare.js'
import type { CredentialProvider } from '../../src/protection/index.js'
import { createOperationResult } from '../../src/repository/index.js'
import { runScheduledBackup } from '../../src/scheduler/run.js'
import type { SchedulerRunRecord } from '../../src/scheduler/types.js'

const repositoryId = '11111111-1111-4111-8111-111111111111'

function resolved(intervalHours = 12): ResolvedBackupConfiguration {
  return {
    config: {
      destination: { name: 'external', path: '/Volumes/Backup', type: 'local' },
      repository: { id: repositoryId, protection: 'encrypted' },
      plugins: ['files'],
      daemon: { intervalHours },
      maxSnapshots: 14,
      plaintextSecretAcceptances: [],
    },
    plugins: [{ name: 'files' }],
    plan: { sources: [], plugins: [] },
    repositoryPath: '/Volumes/Backup/restore-backup',
  } as unknown as ResolvedBackupConfiguration
}

function successfulBackup() {
  return createOperationResult({
    operation: 'backup',
    state: 'success',
    category: 'success',
    repositoryId,
    pointId: 'point-1',
    startedAt: '2026-07-18T00:00:00.000Z',
    endedAt: '2026-07-18T00:01:00.000Z',
    verificationScope: 'content',
    counts: { filesConsidered: 1, filesWritten: 1, bytesRead: 10, bytesWritten: 20 },
  })
}

function failedBackup(category: 'lock' | 'destination' | 'integrity', code: string) {
  return createOperationResult({
    operation: 'backup',
    state: 'failure',
    category,
    repositoryId,
    pointId: 'point-failed',
    startedAt: '2026-07-18T00:00:00.000Z',
    endedAt: '2026-07-18T00:01:00.000Z',
    verificationScope: 'structural',
    issues: [{ code, category, message: 'classified failure' }],
  })
}

function previousHealthy(at: string): SchedulerRunRecord {
  return {
    schemaVersion: 1,
    operation: 'scheduled-backup',
    state: 'success',
    category: 'success',
    repositoryId,
    pointId: 'previous',
    startedAt: at,
    endedAt: at,
    durationMs: 0,
    healthyPublished: true,
    latestHealthyAt: at,
    degraded: false,
    issueCode: null,
    notification: 'not-required',
  }
}

function clock(...values: string[]): () => Date {
  let index = 0
  return () => new Date(values[Math.min(index++, values.length - 1)] as string)
}

function credentialProvider(): CredentialProvider {
  return {} as CredentialProvider
}

describe('one-shot scheduled backup', () => {
  it('runs the verified v1 backup and records its completion notification', async () => {
    const create = vi.fn<
      Parameters<typeof createV1RecoveryPoint>,
      ReturnType<typeof createV1RecoveryPoint>
    >(async () => successfulBackup())
    const prepare = vi.fn(async () => undefined) as unknown as typeof preparePlugins
    const record = vi.fn(async () => undefined)
    const notify = vi.fn(async () => true)
    const inspect = vi.fn(async () => ({
      recoveryPoints: { latestHealthyAt: '2026-07-18T00:01:00.000Z' },
    })) as unknown as typeof getV1Status
    const result = await runScheduledBackup({
      resolveConfiguration: () => resolved(),
      createRecoveryPoint: create,
      inspectStatus: inspect,
      prepare,
      credentialProvider,
      targetExists: async () => true,
      listHistory: async () => [],
      recordHistory: record,
      notify,
      now: clock('2026-07-18T00:00:00.000Z'),
    })
    expect(result).toMatchObject({
      state: 'success',
      healthyPublished: true,
      latestHealthyAt: '2026-07-18T00:01:00.000Z',
      degraded: false,
      notification: 'sent',
    })
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      repositoryPath: '/Volumes/Backup/restore-backup',
      expectedRepositoryId: repositoryId,
      expectedProtection: 'encrypted',
    })
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('heldLock')
    expect(notify).toHaveBeenCalledWith({
      title: 'Restore backup complete',
      message: 'Scheduled backup completed successfully.',
    })
    expect(record).toHaveBeenCalledWith(result)
  })

  it('does not prepare sources or create a replacement path when the target is missing', async () => {
    const create = vi.fn() as unknown as typeof createV1RecoveryPoint
    const prepare = vi.fn() as unknown as typeof preparePlugins
    const record = vi.fn(async () => undefined)
    const notify = vi.fn(async () => true)
    const result = await runScheduledBackup({
      resolveConfiguration: () => resolved(),
      createRecoveryPoint: create,
      prepare,
      credentialProvider,
      targetExists: async () => false,
      listHistory: async () => [previousHealthy('2026-07-17T23:00:00.000Z')],
      recordHistory: record,
      notify,
      now: clock('2026-07-18T00:00:00.000Z', '2026-07-18T00:00:01.000Z'),
    })
    expect(create).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      state: 'failure',
      category: 'destination',
      issueCode: 'SCHEDULER_TARGET_UNAVAILABLE',
      degraded: false,
      notification: 'sent',
    })
    expect(notify).toHaveBeenCalledOnce()
  })

  it('marks the repository degraded after 24 hours without a known healthy backup', async () => {
    const result = await runScheduledBackup({
      resolveConfiguration: () => resolved(),
      targetExists: async () => false,
      listHistory: async () => [previousHealthy('2026-07-16T23:59:59.000Z')],
      recordHistory: async () => undefined,
      notify: async () => true,
      now: clock('2026-07-18T00:00:00.000Z', '2026-07-18T00:00:01.000Z'),
    })
    expect(result.degraded).toBe(true)
    expect(result.notification).toBe('sent')
  })

  it('never backs up when a stale LaunchAgent observes interval 0', async () => {
    const create = vi.fn() as unknown as typeof createV1RecoveryPoint
    const result = await runScheduledBackup({
      resolveConfiguration: () => resolved(0),
      createRecoveryPoint: create,
      listHistory: async () => [previousHealthy('2026-07-18T00:00:00.000Z')],
      recordHistory: async () => undefined,
      notify: async () => true,
      now: clock('2026-07-18T01:00:00.000Z', '2026-07-18T01:00:01.000Z'),
    })
    expect(create).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      state: 'warning',
      issueCode: 'SCHEDULER_DISABLED',
      degraded: false,
    })
  })

  it('surfaces unreadable local history through both notification and final record', async () => {
    const record = vi.fn(async () => undefined)
    const notify = vi.fn(async () => true)
    const result = await runScheduledBackup({
      resolveConfiguration: () => resolved(),
      createRecoveryPoint: vi.fn(async () =>
        successfulBackup(),
      ) as unknown as typeof createV1RecoveryPoint,
      inspectStatus: vi.fn(async () => ({
        recoveryPoints: { latestHealthyAt: '2026-07-18T00:01:00.000Z' },
      })) as unknown as typeof getV1Status,
      credentialProvider,
      targetExists: async () => true,
      listHistory: async () => {
        throw new Error('unsafe')
      },
      recordHistory: record,
      notify,
      now: clock('2026-07-18T00:00:00.000Z'),
    })
    expect(result.issueCode).toBe('SCHEDULER_HISTORY_UNAVAILABLE')
    expect(result.notification).toBe('sent')
    expect(record).toHaveBeenCalledOnce()
  })

  it('preserves and notifies lock, target-identity, and content-verification failures', async () => {
    const failures = [
      failedBackup('lock', 'REPOSITORY_LOCKED'),
      failedBackup('destination', 'REPOSITORY_TARGET_CHANGED'),
      failedBackup('integrity', 'CONTENT_VERIFICATION_FAILED'),
    ]
    for (const failure of failures) {
      const notifications: string[] = []
      const result = await runScheduledBackup({
        resolveConfiguration: () => resolved(),
        createRecoveryPoint: vi.fn(async () => failure) as unknown as typeof createV1RecoveryPoint,
        inspectStatus: vi.fn(async () => ({
          recoveryPoints: { latestHealthyAt: '2026-07-17T23:00:00.000Z' },
        })) as unknown as typeof getV1Status,
        credentialProvider,
        targetExists: async () => true,
        listHistory: async () => [previousHealthy('2026-07-17T23:00:00.000Z')],
        recordHistory: async () => undefined,
        notify: async (input) => {
          notifications.push(input.message)
          return true
        },
        now: clock('2026-07-18T00:00:00.000Z'),
      })
      expect(result.issueCode).toBe(failure.issues[0]?.code)
      expect(result.notification).toBe('sent')
      expect(notifications[0]).toContain(failure.issues[0]?.code)
    }
  })

  it('records a status-confirmed healthy point even when lock release degraded the operation', async () => {
    const degraded = createOperationResult({
      operation: 'backup',
      state: 'degraded',
      category: 'lock',
      repositoryId,
      pointId: 'point-degraded',
      startedAt: '2026-07-18T00:00:00.000Z',
      endedAt: '2026-07-18T00:01:00.000Z',
      verificationScope: 'content',
      issues: [{ code: 'LOCK_RELEASE_FAILED', category: 'lock', message: 'release failed' }],
    })
    const result = await runScheduledBackup({
      resolveConfiguration: () => resolved(),
      createRecoveryPoint: vi.fn(async () => degraded) as unknown as typeof createV1RecoveryPoint,
      inspectStatus: vi.fn(async () => ({
        recoveryPoints: {
          latestHealthyId: 'point-degraded',
          latestHealthyAt: '2026-07-18T00:01:00.000Z',
        },
      })) as unknown as typeof getV1Status,
      credentialProvider,
      targetExists: async () => true,
      listHistory: async () => [],
      recordHistory: async () => undefined,
      notify: async () => true,
      now: clock('2026-07-18T00:00:00.000Z'),
    })
    expect(result).toMatchObject({
      state: 'degraded',
      healthyPublished: true,
      degraded: false,
      notification: 'sent',
    })
  })
})

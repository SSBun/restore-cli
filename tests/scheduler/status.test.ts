import { describe, expect, it } from 'vitest'
import { getSchedulerStatus } from '../../src/scheduler/status.js'
import type { SchedulerRunRecord } from '../../src/scheduler/types.js'

function healthy(at: string): SchedulerRunRecord {
  return {
    schemaVersion: 1,
    operation: 'scheduled-backup',
    state: 'success',
    category: 'success',
    repositoryId: 'repo',
    pointId: 'point',
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

describe('scheduler status', () => {
  it('reports an active schedule, next run, and healthy RPO', async () => {
    const result = await getSchedulerStatus(12, {
      launchAgentStatus: async () => ({ installed: true, loaded: true }),
      history: async () => [healthy('2026-07-18T00:00:00.000Z')],
      now: () => new Date('2026-07-18T01:00:00.000Z'),
    })
    expect(result).toMatchObject({
      state: 'success',
      enabled: true,
      installed: true,
      loaded: true,
      degraded: false,
      nextScheduledAt: '2026-07-18T12:00:00.000Z',
    })
  })

  it('reports stopped scheduling and a stale RPO as degraded', async () => {
    const result = await getSchedulerStatus(12, {
      launchAgentStatus: async () => ({ installed: false, loaded: false }),
      history: async () => [healthy('2026-07-16T00:00:00.000Z')],
      now: () => new Date('2026-07-18T00:00:01.000Z'),
    })
    expect(result.state).toBe('degraded')
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'SCHEDULER_NOT_ACTIVE',
      'RPO_DEGRADED',
    ])
  })

  it('uses a strict greater-than 24-hour degraded boundary', async () => {
    const result = await getSchedulerStatus(12, {
      launchAgentStatus: async () => ({ installed: true, loaded: true }),
      history: async () => [healthy('2026-07-17T00:00:00.000Z')],
      now: () => new Date('2026-07-18T00:00:00.000Z'),
    })
    expect(result.rpoAgeMs).toBe(86_400_000)
    expect(result.degraded).toBe(false)
  })

  it('fails closed when history or launchd status cannot be trusted', async () => {
    const result = await getSchedulerStatus(12, {
      launchAgentStatus: async () => ({ installed: true, loaded: true }),
      history: async () => {
        throw new Error('bad history')
      },
    })
    expect(result).toMatchObject({
      state: 'failure',
      category: 'integrity',
      degraded: true,
    })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchedulerRunRecord } from '../scheduler/types.js'

const runScheduledBackup = vi.hoisted(() => vi.fn())

vi.mock('../scheduler/run.js', () => ({ runScheduledBackup }))

import { createDaemonTick } from './tick.js'

const result: SchedulerRunRecord = {
  schemaVersion: 1,
  operation: 'scheduled-backup',
  state: 'success',
  category: 'success',
  repositoryId: 'repo',
  pointId: 'point',
  startedAt: '2026-07-18T00:00:00.000Z',
  endedAt: '2026-07-18T00:00:01.000Z',
  durationMs: 1000,
  healthyPublished: true,
  latestHealthyAt: '2026-07-18T00:00:01.000Z',
  degraded: false,
  issueCode: null,
  notification: 'not-required',
}

describe('daemon tick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('coalesces concurrent one-shot invocations in the same process', async () => {
    let finish: ((value: SchedulerRunRecord) => void) | undefined
    runScheduledBackup.mockReturnValue(
      new Promise<SchedulerRunRecord>((resolve) => {
        finish = resolve
      }),
    )
    const tick = createDaemonTick()
    const first = tick()
    const second = tick()
    expect(runScheduledBackup).toHaveBeenCalledTimes(1)
    finish?.(result)
    await expect(first).resolves.toEqual(result)
    await expect(second).resolves.toEqual(result)
  })
})

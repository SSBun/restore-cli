import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listSchedulerHistory,
  recordSchedulerRun,
  validateSchedulerRunRecord,
} from '../../src/scheduler/history.js'
import type { SchedulerRunRecord } from '../../src/scheduler/types.js'

const roots: string[] = []

function record(second: number): SchedulerRunRecord {
  const started = new Date(Date.UTC(2026, 6, 18, 0, 0, second))
  const ended = new Date(started.getTime() + 1000)
  return {
    schemaVersion: 1,
    operation: 'scheduled-backup',
    state: 'success',
    category: 'success',
    repositoryId: 'repo-id',
    pointId: `point-${second}`,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    durationMs: 1000,
    healthyPublished: true,
    latestHealthyAt: ended.toISOString(),
    degraded: false,
    issueCode: null,
    notification: 'not-required',
  }
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'restore-scheduler-history-'))
  roots.push(root)
  return join(root, 'state', 'history')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('scheduler local history', () => {
  it('writes private, bounded, newest-first final results', async () => {
    const directory = await fixture()
    await recordSchedulerRun(record(0), {
      historyDirectory: directory,
      limit: 2,
      id: '00000000-0000-4000-8000-000000000001',
    })
    await recordSchedulerRun(record(2), {
      historyDirectory: directory,
      limit: 2,
      id: '00000000-0000-4000-8000-000000000002',
    })
    const latestPath = await recordSchedulerRun(record(4), {
      historyDirectory: directory,
      limit: 2,
      id: '00000000-0000-4000-8000-000000000003',
    })
    const history = await listSchedulerHistory(directory)
    expect(history.map((entry) => entry.pointId)).toEqual(['point-4', 'point-2'])
    const stat = await lstat(directory)
    expect(stat.mode & 0o777).toBe(0o700)
    expect((await lstat(latestPath)).mode & 0o777).toBe(0o600)
  })

  it('rejects malformed records and unknown fields', () => {
    expect(() => validateSchedulerRunRecord({ ...record(0), extra: true })).toThrow('unsafe')
    expect(() => validateSchedulerRunRecord({ ...record(0), durationMs: 99 })).toThrow('unsafe')
    expect(() => validateSchedulerRunRecord({ ...record(0), pointId: null })).toThrow('unsafe')
  })

  it('fails closed on malformed history files', async () => {
    const directory = await fixture()
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, '2026-07-18T00-00-01.000Z-00000000-0000-4000-8000-000000000001.json'),
      '{"schemaVersion":1}',
    )
    await expect(listSchedulerHistory(directory)).rejects.toThrow('unsafe')
  })

  it('does not follow a substituted history directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restore-scheduler-history-link-'))
    roots.push(root)
    const outside = join(root, 'outside')
    const history = join(root, 'state', 'history')
    await mkdir(outside)
    await mkdir(join(root, 'state'))
    await symlink(outside, history)
    await expect(listSchedulerHistory(history)).rejects.toThrow('unsafe')
  })
})

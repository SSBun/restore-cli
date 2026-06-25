import { describe, expect, it } from 'vitest'
import type { Config } from '../config/types.js'
import { createDaemonTick } from './tick.js'

const config: Config = {
  destination: { name: 'local', path: '/tmp/restore', type: 'local' },
  plugins: [],
  daemon: { intervalHours: 1 },
  maxSnapshots: 14,
}

describe('daemon tick', () => {
  it('skips a tick while a backup is already running', async () => {
    let finishFirstBackup: (() => void) | undefined
    const calls: string[] = []
    const messages: string[] = []

    const tick = createDaemonTick({
      loadConfig: () => config,
      executeBackup: async () => {
        calls.push('backup')
        await new Promise<void>((resolve) => {
          finishFirstBackup = resolve
        })
        return { snapshotName: 'snapshot-1' }
      },
      info: (message) => messages.push(message),
      error: (message) => messages.push(message),
    })

    const first = tick()
    await tick()

    expect(calls).toHaveLength(1)
    expect(messages.some((message) => message.includes('already running'))).toBe(true)

    finishFirstBackup?.()
    await first

    const third = tick()
    finishFirstBackup?.()
    await third

    expect(calls).toHaveLength(2)
  })
})

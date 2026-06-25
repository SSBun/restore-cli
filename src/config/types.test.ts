import { describe, expect, it } from 'vitest'
import { ConfigSchema } from './types.js'

describe('config schema', () => {
  it('allows daemon interval 0 to disable background backups', () => {
    const config = ConfigSchema.parse({
      destination: { name: 'local', path: '/tmp/restore', type: 'local' },
      daemon: { intervalHours: 0 },
    })

    expect(config.daemon.intervalHours).toBe(0)
  })
})

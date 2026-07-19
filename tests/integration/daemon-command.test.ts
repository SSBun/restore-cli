import { Command } from 'commander'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDaemonCommand } from '../../src/cli/daemon.js'
import type { Config } from '../../src/config/types.js'

const config: Config = {
  destination: { name: 'local', path: '/tmp/restore', type: 'local' },
  plugins: [],
  daemon: { intervalHours: 0 },
  maxSnapshots: 14,
}

describe('daemon command', () => {
  const output: string[] = []
  const start = vi.fn(async () => ({ installed: true, loaded: true }))
  const stop = vi.fn(async () => ({ installed: false, loaded: false }))
  const status = vi.fn()
  const setExitCode = vi.fn()

  function program(load = () => config): Command {
    const value = new Command()
    value.exitOverride()
    registerDaemonCommand(value, {
      load,
      start,
      stop,
      status,
      launchDefinition: (intervalHours) => ({
        executable: '/usr/local/bin/node',
        arguments: ['/tmp/worker.js'],
        intervalHours,
      }),
      writeStdout: (text) => output.push(text),
      writeStderr: (text) => output.push(text),
      setExitCode,
    })
    return value
  }

  beforeEach(() => {
    output.length = 0
    vi.clearAllMocks()
  })

  it('actively removes a stale LaunchAgent when interval 0 disables scheduling', async () => {
    await program().parseAsync(['node', 'test', 'daemon', 'start'])
    expect(start).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      operation: 'scheduler-start',
      enabled: false,
      state: 'success',
    })
  })

  it('installs the persistent worker with the configured interval', async () => {
    await program(() => ({ ...config, daemon: { intervalHours: 12 } })).parseAsync([
      'node',
      'test',
      'daemon',
      'start',
    ])
    expect(start).toHaveBeenCalledWith({
      executable: '/usr/local/bin/node',
      arguments: ['/tmp/worker.js'],
      intervalHours: 12,
    })
  })

  it('returns a stable failure without throwing when configuration is invalid', async () => {
    await program(() => {
      throw new Error('invalid')
    }).parseAsync(['node', 'test', 'daemon', 'status'])
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({
      operation: 'scheduler-status',
      state: 'failure',
      category: 'configuration',
    })
    expect(setExitCode).toHaveBeenCalledWith(10)
  })
})

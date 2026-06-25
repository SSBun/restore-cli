import { Command } from 'commander'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDaemonCommand } from '../../src/cli/daemon.js'
import { startDaemon } from '../../src/daemon/scheduler.js'

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: () => ({
    destination: { name: 'local', path: '/tmp/restore', type: 'local' },
    plugins: [],
    daemon: { intervalHours: 0 },
    maxSnapshots: 14,
  }),
}))

vi.mock('../../src/daemon/lifecycle.js', () => ({
  isDaemonRunning: () => false,
}))

vi.mock('../../src/daemon/scheduler.js', () => ({
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
}))

function createProgram(output: string[]): Command {
  const program = new Command()
  program.exitOverride()
  program.configureOutput({
    writeOut: (text) => output.push(text),
    writeErr: (text) => output.push(text),
  })
  registerDaemonCommand(program)
  return program
}

describe('daemon command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not start the daemon when interval is 0', async () => {
    const output: string[] = []
    const consoleLog = vi
      .spyOn(console, 'log')
      .mockImplementation((message) => output.push(message))

    try {
      const program = createProgram(output)
      await program.parseAsync(['node', 'test', 'daemon', 'start'])
    } finally {
      consoleLog.mockRestore()
    }

    expect(startDaemon).not.toHaveBeenCalled()
    expect(output.join('')).toContain('disabled')
  })
})

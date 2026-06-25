import { Command } from 'commander'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerStatusCommand } from '../../src/cli/status.js'

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: () => ({
    destination: { name: 'local', path: '/tmp/restore', type: 'local' },
    plugins: [],
    daemon: { intervalHours: 12 },
    maxSnapshots: 14,
  }),
}))

vi.mock('../../src/daemon/lifecycle.js', () => ({
  isDaemonRunning: () => true,
}))

vi.mock('../../src/engine/stat.js', () => ({
  getBackupStat: () => ({
    backupRoot: '/tmp/restore/RestoreBackup',
    snapshotCount: 2,
    lastBackupName: '2026-06-23T01-02-03.004',
    lastBackupAt: new Date('2026-06-23T01:02:03.004Z'),
    latestSnapshotBytes: 1536,
    latestSnapshotFiles: 3,
    totalBackupBytes: 4096,
    totalBackupFiles: 8,
  }),
}))

function createProgram(output: string[]): Command {
  const program = new Command()
  program.exitOverride()
  program.configureOutput({
    writeOut: (text) => output.push(text),
    writeErr: (text) => output.push(text),
  })
  registerStatusCommand(program)
  return program
}

describe('status command', () => {
  beforeEach(() => {
    process.exitCode = undefined
  })

  it('prints backup status', async () => {
    const output: string[] = []
    const consoleLog = vi
      .spyOn(console, 'log')
      .mockImplementation((message) => output.push(message))
    const program = createProgram(output)

    try {
      await program.parseAsync(['node', 'test', 'status'])
    } finally {
      consoleLog.mockRestore()
    }

    const text = output.join('\n')
    expect(text).toContain('Destination: local')
    expect(text).toContain('Daemon: running')
    expect(text).toContain('Snapshots: 2')
    expect(text).toContain('Last backup: 2026-06-23T01:02:03.004Z')
    expect(text).toContain('Latest snapshot size: 1.5 KB')
    expect(text).toContain('Total backup size: 4.0 KB')
  })
})

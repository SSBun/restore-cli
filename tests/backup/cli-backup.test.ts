import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { registerBackupCommand } from '../../src/cli/backup.js'
import type { ResolvedBackupConfiguration } from '../../src/config/loader.js'
import { createOperationResult } from '../../src/repository/index.js'

function resolvedConfiguration(): ResolvedBackupConfiguration {
  const plugin = {
    name: 'test-plugin',
    description: 'test',
    paths: ['/safe/source'],
    sources: [
      {
        name: 'source',
        path: '/safe/source',
        requirement: 'optional' as const,
        sensitivity: 'private' as const,
        expectedType: 'file' as const,
        recoveryScope: 'exact',
      },
    ],
  }
  return {
    config: {
      destination: { name: 'local', path: '/safe/target', type: 'local' },
      repository: {
        id: '00000000-0000-4000-8000-000000000001',
        protection: 'plaintext',
      },
      plugins: ['test-plugin'],
      daemon: { intervalHours: 0 },
      maxSnapshots: 14,
    },
    plugins: [plugin],
    plan: {
      plugins: [plugin],
      sources: [
        {
          id: 'test-plugin:source',
          plugin: 'test-plugin',
          name: 'source',
          declaredPath: '/safe/source',
          path: '/safe/source',
          requirement: 'optional',
          sensitivity: 'private',
          expectedType: 'file',
          recoveryScope: 'exact',
          includeEmptyDirectories: false,
        },
      ],
    },
    repositoryPath: '/safe/target/RestoreBackup',
  }
}

describe('backup CLI result discipline', () => {
  it('prints one strict configuration result and does not leak the thrown error', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCodes: number[] = []
    const program = new Command()
    registerBackupCommand(program, {
      resolveConfiguration() {
        throw new Error('/Users/example/.ssh/private-secret')
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => exitCodes.push(value),
    })

    await program.parseAsync(['node', 'restore-cli', 'backup'])

    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({
      operation: 'backup',
      state: 'failure',
      category: 'configuration',
      issues: [{ code: 'BACKUP_CONFIGURATION_INVALID' }],
    })
    expect(`${stdout.join('')} ${stderr.join('')}`).not.toContain('private-secret')
    expect(stderr).toEqual(['backup: BACKUP_CONFIGURATION_INVALID'])
    expect(exitCodes).toEqual([10])
  })

  it('notifies after a manual backup completes', async () => {
    const resolved = resolvedConfiguration()
    const exitCodes: number[] = []
    const notify = vi.fn(async () => {
      throw new Error('notifications unavailable')
    })
    const program = new Command()
    registerBackupCommand(program, {
      resolveConfiguration: () => resolved,
      createRecoveryPoint: vi.fn(async () =>
        createOperationResult({
          operation: 'backup',
          state: 'success',
          category: 'success',
          repositoryId: resolved.config.repository?.id,
          startedAt: '2026-07-19T00:00:00.000Z',
          endedAt: '2026-07-19T00:00:01.000Z',
          verificationScope: 'content',
        }),
      ),
      prepare: vi.fn(async () => undefined),
      notify,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      setExitCode: (value) => exitCodes.push(value),
    })

    await program.parseAsync(['node', 'restore-cli', 'backup'])

    expect(notify).toHaveBeenCalledWith({
      title: 'Restore backup complete',
      message: 'Manual backup completed successfully.',
    })
    expect(exitCodes).toEqual([0])
  })

  it('uses one immutable plan and skips prepare in dry-run', async () => {
    const resolved = resolvedConfiguration()
    const stdout: string[] = []
    const prepare = vi.fn()
    const notify = vi.fn(async () => true)
    const createRecoveryPoint = vi.fn(async (options) => {
      expect(options.plan).toBe(resolved.plan)
      expect(options.beforeCapture).toBeUndefined()
      return createOperationResult({
        operation: 'backup',
        state: 'success',
        category: 'success',
        repositoryId: resolved.config.repository?.id,
        startedAt: '2026-07-19T00:00:00.000Z',
        endedAt: '2026-07-19T00:00:01.000Z',
        verificationScope: 'structural',
      })
    })
    const program = new Command()
    registerBackupCommand(program, {
      resolveConfiguration: () => resolved,
      createRecoveryPoint,
      prepare,
      notify,
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })

    await program.parseAsync(['node', 'restore-cli', 'backup', '--dry-run'])

    expect(createRecoveryPoint).toHaveBeenCalledOnce()
    expect(prepare).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({
      state: 'success',
      verificationScope: 'structural',
    })
  })
})

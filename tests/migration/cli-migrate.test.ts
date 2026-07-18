import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { registerMigrateCommand } from '../../src/cli/migrate.js'
import { LegacyMigrationError } from '../../src/migration/index.js'
import type { LegacyMigrationReport } from '../../src/migration/index.js'

function report(dryRun = true): LegacyMigrationReport {
  return {
    operation: 'legacy-migrate',
    startedAt: '2026-07-19T00:00:00.000Z',
    endedAt: '2026-07-19T00:00:01.000Z',
    dryRun,
    state: 'success',
    category: 'success',
    counts: {
      filesConsidered: 0,
      filesWritten: 0,
      filesSkipped: 0,
      filesFailed: 0,
      bytesRead: 0,
      bytesWritten: 0,
    },
    verificationScope: dryRun ? 'structural' : 'content',
    source: {
      repositoryPath: '/legacy',
      repositoryDigest: 'digest',
      readOnly: true,
      deleted: false,
    },
    target: {
      repositoryPath: '/target/RestoreBackup',
      repositoryId: 'repo-id',
      protection: 'plaintext',
      requiredBytes: '1',
      availableBytes: '100',
      authenticated: true,
      capabilityChecked: !dryRun,
      lockChecked: !dryRun,
    },
    points: [],
    results: [],
    unsupported: [],
    finalRepositoryVerified: !dryRun,
    limitations: [],
  }
}

describe('migrate CLI boundary', () => {
  it('defaults to dry-run and passes repeatable point selections', async () => {
    const stdout: string[] = []
    const migrate = vi.fn(async (options) => {
      expect(options).toMatchObject({
        legacyRepositoryPath: '/legacy',
        repositoryPath: '/target/RestoreBackup',
        pointIds: ['point-a', 'point-b'],
        dryRun: true,
      })
      return report()
    })
    const program = new Command()
    registerMigrateCommand(program, {
      resolve: () => ({
        repositoryPath: '/target/RestoreBackup',
        repositoryId: 'repo-id',
        protection: 'plaintext',
      }),
      migrate,
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })

    await program.parseAsync([
      'node',
      'restore-cli',
      'migrate',
      '--from',
      '/legacy',
      '--point',
      'point-a',
      '--point',
      'point-b',
    ])

    expect(migrate).toHaveBeenCalledOnce()
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({ dryRun: true, state: 'success' })
  })

  it('uses an explicit execute switch and redacts configuration exceptions', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCodes: number[] = []
    const program = new Command()
    registerMigrateCommand(program, {
      resolve() {
        throw new Error('/Users/alice/.ssh/private')
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => exitCodes.push(value),
    })

    await program.parseAsync(['node', 'restore-cli', 'migrate', '--from', '/legacy', '--execute'])

    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      state: 'failure',
      category: 'configuration',
      results: [{ issues: [{ code: 'MIGRATION_CONFIGURATION_INVALID' }] }],
    })
    expect(`${stdout.join('')} ${stderr.join('')}`).not.toContain('private')
    expect(exitCodes).toEqual([10])
  })

  it('preserves migration safety categories instead of relabeling them as configuration', async () => {
    const stdout: string[] = []
    const exitCodes: number[] = []
    const program = new Command()
    registerMigrateCommand(program, {
      resolve: () => ({
        repositoryPath: '/target/RestoreBackup',
        repositoryId: 'repo-id',
        protection: 'plaintext',
      }),
      migrate: async () => {
        throw new LegacyMigrationError(
          'UNSUPPORTED_PLATFORM',
          'unsupported',
          'Apple Silicon macOS is required',
        )
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
      setExitCode: (value) => exitCodes.push(value),
    })

    await program.parseAsync(['node', 'restore-cli', 'migrate', '--from', '/legacy'])

    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      category: 'unsupported',
      results: [{ issues: [{ code: 'UNSUPPORTED_PLATFORM' }] }],
    })
    expect(exitCodes).toEqual([16])
  })
})

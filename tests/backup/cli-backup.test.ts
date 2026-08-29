import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { registerBackupCommand } from '../../src/cli/backup.js'
import type { ResolvedBackupConfiguration } from '../../src/config/loader.js'

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
      plugins: ['test-plugin'],
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
          exclude: [],
        },
      ],
    },
    mirrorPath: '/safe/target/RestoreBackup',
  }
}

describe('backup CLI', () => {
  it('shows a structured source table and performs a no-write dry-run', async () => {
    const resolved = resolvedConfiguration()
    const stdout: string[] = []
    const stderr: string[] = []
    const prepare = vi.fn()
    const synchronize = vi.fn(async (options) => {
      expect(options).toMatchObject({ root: resolved.mirrorPath, dryRun: true })
      return {
        manifest: {
          formatVersion: 1 as const,
          generatedAt: '2026-01-01T00:00:00.000Z',
          sources: [
            {
              id: 'test-plugin:source',
              plugin: 'test-plugin',
              name: 'source',
              declaredPath: '/safe/source',
              exclude: [],
              status: 'present' as const,
            },
          ],
          entries: [
            {
              sourceId: 'test-plugin:source',
              relativePath: '.',
              type: 'file' as const,
              mode: 0o600,
              size: 4,
              sha256: '0'.repeat(64),
            },
          ],
        },
        diff: [
          {
            action: 'create' as const,
            sourceId: 'test-plugin:source',
            relativePath: '.',
            type: 'file' as const,
          },
        ],
        changed: false,
        replacedLegacy: false,
        repaired: false,
      }
    })
    const program = new Command()
    registerBackupCommand(program, {
      resolveConfiguration: () => resolved,
      synchronize,
      prepare,
      progress: () => ({ start: vi.fn(), update: vi.fn(), stop: vi.fn() }),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: vi.fn(),
    })

    await program.parseAsync(['node', 'restore-cli', 'backup', '--dry-run'])

    expect(prepare).not.toHaveBeenCalled()
    expect(synchronize).toHaveBeenCalledOnce()
    expect(stderr.join('\n')).toContain('Contract / Path')
    expect(stderr.join('\n')).toContain('Changes (1)')
    expect(JSON.parse(stdout[0])).toMatchObject({
      operation: 'backup',
      state: 'success',
      dryRun: true,
      counts: { created: 1 },
    })
  })
})

import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { registerV1ApplyCommands } from '../../src/cli/apply.js'
import { registerRestoreCommand } from '../../src/cli/restore.js'
import type { ApplyResult, RecoveryResult } from '../../src/recovery/index.js'

const counts = {
  filesConsidered: 0,
  restored: 0,
  unchanged: 0,
  skipped: 0,
  conflicted: 0,
  failed: 0,
  fidelityLoss: 0,
  bytesRead: 0,
  bytesWritten: 0,
  bytesVerified: 0,
}

function stageResult(): RecoveryResult {
  const now = new Date().toISOString()
  return {
    operation: 'stage-recovery',
    state: 'success',
    category: 'success',
    startedAt: now,
    endedAt: now,
    repositoryId: 'repo',
    protection: 'plaintext',
    pointId: 'point',
    stagingId: 'stage',
    stagingPath: '/stage',
    partialAccepted: false,
    selection: { kind: 'all' },
    plugins: [],
    sources: [],
    selectedPaths: [],
    limitations: [],
    counts,
    issues: [],
    nextAction: null,
  }
}

function applyResult(dryRun: boolean): ApplyResult {
  const now = new Date().toISOString()
  return {
    operation: 'apply',
    state: 'success',
    category: 'success',
    dryRun,
    startedAt: now,
    endedAt: now,
    repositoryId: 'repo',
    protection: 'plaintext',
    pointId: 'point',
    stagingId: 'stage',
    applyId: 'apply',
    safetyId: dryRun ? null : 'safety',
    conflictPolicy: 'error',
    planFingerprint: 'fingerprint',
    counts,
    items: [],
    issues: [],
    nextAction: null,
  }
}

describe('v1 recovery CLI contracts', () => {
  it('emits one JSON restore result and passes an explicit manifest path selection', async () => {
    const program = new Command().exitOverride()
    const stdout: string[] = []
    const stderr: string[] = []
    const exits: number[] = []
    const stage = vi.fn(async () => stageResult())
    registerRestoreCommand(program, {
      stage,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => exits.push(value),
    })
    await program.parseAsync([
      'node',
      'test',
      'restore-v1',
      '--repository',
      '/repo',
      '--repository-id',
      'repo',
      '--protection',
      'plaintext',
      '--staging',
      '/stage-root',
      '--path',
      'plugin:source=.config/tool',
    ])

    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: {
          kind: 'paths',
          paths: [{ sourceId: 'plugin:source', relativePath: '.config/tool' }],
        },
      }),
    )
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({ operation: 'stage-recovery', state: 'success' })
    expect(stderr).toEqual([])
    expect(exits).toEqual([0])
  })

  it('keeps apply dry-run by default and requires --execute for mutation', async () => {
    const program = new Command().exitOverride()
    const stdout: string[] = []
    const dryRuns: boolean[] = []
    const fidelityConsents: Array<string | undefined> = []
    registerV1ApplyCommands(program, {
      apply: vi.fn(async (options) => {
        dryRuns.push(options.dryRun ?? true)
        fidelityConsents.push(options.fidelityConsent)
        return applyResult(options.dryRun ?? true)
      }),
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })
    const common = [
      '--repository',
      '/repo',
      '--repository-id',
      'repo',
      '--protection',
      'plaintext',
      '--staging',
      '/stage',
      '--target',
      'plugin:source=/target',
    ]
    await program.parseAsync(['node', 'test', 'apply-v1', ...common])
    await program.parseAsync([
      'node',
      'test',
      'apply-v1',
      ...common,
      '--execute',
      '--accept-staging-fidelity-issues',
      'I_ACCEPT_STAGING_FIDELITY_ISSUES',
    ])

    expect(dryRuns).toEqual([true, false])
    expect(fidelityConsents).toEqual([undefined, 'I_ACCEPT_STAGING_FIDELITY_ISSUES'])
    expect(stdout.map((value) => JSON.parse(value).dryRun)).toEqual([true, false])
  })

  it.each([
    ['missing restore fields', ['restore-v1']],
    [
      'restore dry-run',
      [
        'restore-v1',
        '--repository',
        '/repo',
        '--repository-id',
        'repo',
        '--protection',
        'plaintext',
        '--staging',
        '/stage',
        '--dry-run',
      ],
    ],
    [
      'conflicting restore selectors',
      [
        'restore-v1',
        '--repository',
        '/repo',
        '--repository-id',
        'repo',
        '--protection',
        'plaintext',
        '--staging',
        '/stage',
        '--plugin',
        'tool',
        '--source',
        'tool:config',
      ],
    ],
  ])('emits one JSON failure for %s before doing work', async (_name, arguments_) => {
    const program = new Command().exitOverride()
    const stdout: string[] = []
    const stderr: string[] = []
    const stage = vi.fn(async () => stageResult())
    registerRestoreCommand(program, {
      stage,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: () => undefined,
    })

    await program.parseAsync(['node', 'test', ...arguments_])

    expect(stage).not.toHaveBeenCalled()
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({
      operation: 'stage-recovery',
      state: 'failure',
      category: 'configuration',
    })
    expect(stderr).toEqual(['restore-v1: RESTORE_CONFIGURATION_INVALID'])
  })

  it.each([
    ['missing apply fields', ['apply-v1']],
    [
      'conflicting apply execution flags',
      [
        'apply-v1',
        '--repository',
        '/repo',
        '--repository-id',
        'repo',
        '--protection',
        'plaintext',
        '--staging',
        '/stage',
        '--target',
        'tool:config=/target',
        '--dry-run',
        '--execute',
      ],
    ],
    [
      'conflicting apply policies',
      [
        'apply-v1',
        '--repository',
        '/repo',
        '--repository-id',
        'repo',
        '--protection',
        'plaintext',
        '--staging',
        '/stage',
        '--target',
        'tool:config=/target',
        '--overwrite',
        '--skip',
      ],
    ],
    ['missing rollback fields', ['rollback-v1']],
  ])('emits one JSON failure for %s before doing work', async (_name, arguments_) => {
    const program = new Command().exitOverride()
    const stdout: string[] = []
    const stderr: string[] = []
    const apply = vi.fn(async () => applyResult(true))
    const rollback = vi.fn(async () => applyResult(true))
    registerV1ApplyCommands(program, {
      apply,
      rollback,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: () => undefined,
    })

    await program.parseAsync(['node', 'test', ...arguments_])

    expect(apply).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({ state: 'failure', category: 'configuration' })
    expect(stderr).toHaveLength(1)
  })
})

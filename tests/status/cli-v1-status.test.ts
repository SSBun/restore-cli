import { Command } from 'commander'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerStatusCommand } from '../../src/cli/status.js'
import { registerVerifyCommand } from '../../src/cli/verify.js'
import type { V1StatusResult } from '../../src/engine/v1-stat.js'
import type { VerificationReport } from '../../src/verify/index.js'

const coverage = {
  pointsConsidered: 1,
  pointsVerified: 1,
  pointsSkipped: 0,
  pointsFailed: 0,
  filesConsidered: 1,
  filesVerified: 1,
  filesSkipped: 0,
  filesFailed: 0,
  bytesConsidered: 4,
  bytesVerified: 4,
  bytesSkipped: 0,
  bytesFailed: 0,
  complete: true,
}

function verification(): VerificationReport {
  return {
    operation: 'verify',
    scope: 'content',
    verificationScope: 'content',
    selector: { kind: 'point', pointId: 'point-a' },
    resolvedPointIds: ['point-a'],
    resolvedPointId: 'point-a',
    repositoryId: '11111111-1111-4111-8111-111111111111',
    protection: 'plaintext',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    cost: 'high',
    state: 'success',
    category: 'success',
    ...coverage,
    coverage,
    points: [],
    issues: [],
    nextAction: null,
  }
}

function status(): V1StatusResult {
  return {
    operation: 'status',
    state: 'success',
    category: 'success',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.000Z',
    repositoryId: '11111111-1111-4111-8111-111111111111',
    repositoryLocation: 'volume:11111111-1111-1111-1111-111111111111',
    protection: { mode: 'encrypted', state: 'secure' },
    target: { state: 'available', capabilities: null },
    scheduler: {
      configured: true,
      state: 'running',
      intervalHours: 12,
      nextScheduledAt: null,
    },
    recoveryPoints: {
      healthy: 1,
      partial: 0,
      failed: 0,
      latestId: 'point-a',
      latestHealthyId: 'point-a',
      latestHealthyAt: '2026-01-01T00:00:00.000Z',
    },
    rpo: { ageMs: 0, degradedAfterMs: 86_400_000, degraded: false },
    verification: { structural: null, content: null },
    recentOperations: [],
    issues: [],
    nextAction: null,
  }
}

beforeEach(() => {
  process.exitCode = undefined
})

describe('v1 JSON CLI contracts', () => {
  it('verify emits one JSON result and maps selector/scope/exit code', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    let received: Parameters<typeof registerVerifyCommand>[1] | undefined
    const program = new Command().exitOverride()
    registerVerifyCommand(program, {
      resolve: () => ({
        repositoryPath: '/safe/RestoreBackup',
        repositoryId: '11111111-1111-4111-8111-111111111111',
        protection: 'plaintext',
      }),
      async verify(options) {
        received = options as never
        return verification()
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => {
        process.exitCode = value
      },
    })
    await program.parseAsync(['node', 'test', 'verify', '--point', 'point-a', '--content'])
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({ operation: 'verify', resolvedPointId: 'point-a' })
    expect(received).toMatchObject({
      selector: { kind: 'point', pointId: 'point-a' },
      scope: 'content',
    })
    expect(stderr).toEqual([])
    expect(process.exitCode).toBe(0)
  })

  it('status emits one machine-readable JSON result for a configured v1 repository', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const program = new Command().exitOverride()
    registerStatusCommand(program, {
      load: () => ({
        destination: { name: 'safe', path: '/safe', type: 'local' },
        repository: {
          id: '11111111-1111-4111-8111-111111111111',
          protection: 'encrypted',
        },
        plugins: [],
        daemon: { intervalHours: 12 },
        maxSnapshots: 14,
      }),
      status: async () => status(),
      daemonRunning: () => true,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => {
        process.exitCode = value
      },
    })
    await program.parseAsync(['node', 'test', 'status'])
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({ operation: 'status', state: 'success' })
    expect(stderr).toEqual([])
    expect(process.exitCode).toBe(0)
  })

  it('maps a failed integrity status to exit code 15', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const program = new Command().exitOverride()
    registerStatusCommand(program, {
      load: () => ({
        destination: { name: 'safe', path: '/safe', type: 'local' },
        repository: {
          id: '11111111-1111-4111-8111-111111111111',
          protection: 'encrypted',
        },
        plugins: [],
        daemon: { intervalHours: 12 },
        maxSnapshots: 14,
      }),
      status: async () => ({
        ...status(),
        state: 'failure',
        category: 'integrity',
        issues: [
          {
            code: 'INVALID_POINT_DESCRIPTOR',
            category: 'integrity',
            message: 'Repository verification reported INVALID_POINT_DESCRIPTOR',
          },
        ],
      }),
      daemonRunning: () => true,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => {
        process.exitCode = value
      },
    })
    await program.parseAsync(['node', 'test', 'status'])
    expect(stdout).toHaveLength(1)
    expect(stderr).toEqual(['status: INVALID_POINT_DESCRIPTOR'])
    expect(process.exitCode).toBe(15)
  })

  it('emits one stable configuration failure without falling back to legacy status', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const statusService = vi.fn()
    const program = new Command().exitOverride()
    registerStatusCommand(program, {
      load: () => {
        throw new Error('malformed config with sensitive contents')
      },
      status: statusService,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => {
        process.exitCode = value
      },
    })
    await program.parseAsync(['node', 'test', 'status'])
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({
      operation: 'status',
      state: 'failure',
      category: 'configuration',
      issues: [{ code: 'STATUS_CONFIGURATION_INVALID' }],
    })
    expect(stderr).toEqual(['status: STATUS_CONFIGURATION_INVALID'])
    expect(process.exitCode).toBe(10)
    expect(statusService).not.toHaveBeenCalled()
  })
})

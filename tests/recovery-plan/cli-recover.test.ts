import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRecoverCommand } from '../../src/cli/recover.js'
import { exportRecoverySecret, generateRecoverySecret } from '../../src/protection/index.js'
import {
  MAX_INSTALL_JOURNAL_BYTES,
  RecoveryPlanError,
  executeRecoveryInstallPlan,
  generateRecoveryPlan,
  recoveryInstallJournalBasename,
} from '../../src/recovery-plan/index.js'
import type { RecoveryPlan } from '../../src/recovery-plan/index.js'
import { authenticateStaging, readStagingDescriptor } from '../../src/recovery/index.js'
import { getRepositoryLayout } from '../../src/repository/index.js'
import { createRecoveryPlanFixture } from './fixture.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function plan(): RecoveryPlan {
  return {
    formatVersion: 1,
    operation: 'recovery-plan',
    state: 'success',
    category: 'success',
    dryRun: true,
    startedAt: '2026-07-19T00:00:00.000Z',
    endedAt: '2026-07-19T00:00:00.000Z',
    repository: {
      path: '/repo',
      id: 'repo-id',
      protection: 'plaintext',
      authenticated: true,
    },
    recoveryPoint: {
      id: 'point',
      healthy: true,
      fixed: true,
      contentVerified: true,
      manifestFingerprint: 'a'.repeat(64),
    },
    staging: {
      id: 'staging',
      path: '/staging/point',
      verified: true,
      selectionFingerprint: 'b'.repeat(64),
    },
    configuration: { items: [], stagedOnly: true, originalPathsChanged: false },
    software: [],
    allowlistedActions: [],
    manualDependencies: [],
    phases: [],
    fingerprint: 'c'.repeat(64),
    issues: [],
    nextAction: 'review',
  }
}

describe('recover CLI boundary', () => {
  it('defaults to authenticated planning and never invokes an installer', async () => {
    const stdout: string[] = []
    const planService = vi.fn(async () => plan())
    const install = vi.fn()
    const program = new Command()
    registerRecoverCommand(program, {
      plan: planService,
      install,
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })

    await program.parseAsync([
      'node',
      'restore-cli',
      'recover',
      '--repository',
      '/repo',
      '--repository-id',
      'repo-id',
      '--protection',
      'plaintext',
      '--staging-root',
      '/staging',
    ])

    expect(planService).toHaveBeenCalledOnce()
    expect(install).not.toHaveBeenCalled()
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      operation: 'recovery-plan',
      dryRun: true,
    })
  })

  it('forwards only explicit phases, approval, confirmation, and execute intent', async () => {
    const install = vi.fn(async (options) => {
      expect(options).toMatchObject({
        phases: ['vscode'],
        confirmedPhases: ['vscode'],
        execute: true,
        invocation: 'interactive-cli',
        approvedPlanFingerprint: 'c'.repeat(64),
        stateDirectory: '/private/state',
      })
      return {
        operation: 'recovery-install' as const,
        state: 'success' as const,
        category: 'success' as const,
        dryRun: false,
        startedAt: '2026-07-19T00:00:00.000Z',
        endedAt: '2026-07-19T00:00:01.000Z',
        repositoryId: 'repo-id',
        pointId: 'point',
        planFingerprint: 'c'.repeat(64),
        items: [],
        counts: {
          total: 0,
          pending: 0,
          succeeded: 0,
          alreadyPresent: 0,
          failed: 0,
          manual: 0,
          skipped: 0,
        },
        issues: [],
        nextAction: null,
      }
    })
    const program = new Command()
    registerRecoverCommand(program, {
      install,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })
    await program.parseAsync([
      'node',
      'restore-cli',
      'recover',
      '--repository',
      '/repo',
      '--repository-id',
      'repo-id',
      '--protection',
      'plaintext',
      '--staging-root',
      '/staging',
      '--install-phase',
      'vscode',
      '--confirm-phase',
      'vscode',
      '--execute-install',
      '--approve-plan',
      'c'.repeat(64),
      '--state-directory',
      '/private/state',
    ])
    expect(install).toHaveBeenCalledOnce()
  })

  it('allows an install dry-run without a state directory and still sets execute false', async () => {
    const install = vi.fn(async (options) => {
      expect(options).toMatchObject({ phases: ['homebrew'], execute: false })
      expect(options.stateDirectory).toBeUndefined()
      return {
        operation: 'recovery-install' as const,
        state: 'success' as const,
        category: 'success' as const,
        dryRun: true,
        startedAt: '2026-07-19T00:00:00.000Z',
        endedAt: '2026-07-19T00:00:00.000Z',
        repositoryId: 'repo-id',
        pointId: 'point',
        planFingerprint: 'c'.repeat(64),
        items: [],
        counts: {
          total: 0,
          pending: 0,
          succeeded: 0,
          alreadyPresent: 0,
          failed: 0,
          manual: 0,
          skipped: 0,
        },
        issues: [],
        nextAction: null,
      }
    })
    const program = new Command()
    registerRecoverCommand(program, {
      install,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })
    await program.parseAsync([
      'node',
      'restore-cli',
      'recover',
      '--repository',
      '/repo',
      '--repository-id',
      'repo-id',
      '--protection',
      'plaintext',
      '--staging-root',
      '/staging',
      '--install-phase',
      'homebrew',
    ])
    expect(install).toHaveBeenCalledOnce()
  })

  it('uses the independent recovery file provider without requiring a prior Keychain', async () => {
    const credentialProvider = {
      loadMasterKey: vi.fn(),
      storeMasterKey: vi.fn(),
      deleteMasterKey: vi.fn(),
    }
    const recoveryCredential = vi.fn(() => credentialProvider)
    const planService = vi.fn(async (options) => {
      expect(options.credentialProvider).toBe(credentialProvider)
      return plan()
    })
    const program = new Command()
    registerRecoverCommand(program, {
      plan: planService,
      recoveryCredential,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })
    await program.parseAsync([
      'node',
      'restore-cli',
      'recover',
      '--repository',
      '/repo',
      '--repository-id',
      'repo-id',
      '--protection',
      'encrypted',
      '--recovery-file',
      '/media/recovery.secret',
      '--staging-root',
      '/staging',
    ])
    expect(recoveryCredential).toHaveBeenCalledWith('/repo', '/media/recovery.secret')
    expect(planService).toHaveBeenCalledOnce()
  })

  it('preserves install operation and unsupported exit mapping', async () => {
    const stdout: string[] = []
    const exitCodes: number[] = []
    const program = new Command()
    registerRecoverCommand(program, {
      install: async () => ({
        operation: 'recovery-install',
        state: 'failure',
        category: 'unsupported',
        dryRun: false,
        startedAt: '2026-07-19T00:00:00.000Z',
        endedAt: '2026-07-19T00:00:01.000Z',
        repositoryId: 'repo-id',
        pointId: 'point',
        planFingerprint: 'c'.repeat(64),
        items: [],
        counts: {
          total: 0,
          pending: 0,
          succeeded: 0,
          alreadyPresent: 0,
          failed: 0,
          manual: 0,
          skipped: 0,
        },
        issues: [
          {
            code: 'INSTALLER_BINARY_MISSING',
            category: 'unsupported',
            message: 'missing',
          },
        ],
        nextAction: 'install manually',
      }),
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
      setExitCode: (value) => exitCodes.push(value),
    })
    await program.parseAsync([
      'node',
      'restore-cli',
      'recover',
      '--repository',
      '/repo',
      '--repository-id',
      'repo-id',
      '--protection',
      'plaintext',
      '--staging-root',
      '/staging',
      '--install-phase',
      'vscode',
    ])
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      operation: 'recovery-install',
      category: 'unsupported',
    })
    expect(exitCodes).toEqual([16])
  })

  it('redacts internal failures', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCodes: number[] = []
    const planService = vi.fn(async () => {
      throw new Error('/Users/alice/.ssh/private')
    })
    const program = new Command()
    registerRecoverCommand(program, {
      plan: planService,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      setExitCode: (value) => exitCodes.push(value),
    })
    await program.parseAsync([
      'node',
      'restore-cli',
      'recover',
      '--repository',
      '/repo',
      '--repository-id',
      'repo-id',
      '--protection',
      'plaintext',
      '--staging-root',
      '/staging',
    ])
    expect(`${stdout.join('')} ${stderr.join('')}`).not.toContain('/Users/alice')
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      category: 'internal',
      issues: [{ code: 'RECOVERY_PLAN_FAILED' }],
    })
    expect(exitCodes).toEqual([20])
  })

  it('redacts internal install failures with install-specific operation and code', async () => {
    const stdout: string[] = []
    const program = new Command()
    registerRecoverCommand(program, {
      install: async () => {
        throw new Error('/Users/alice/.ssh/private')
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })
    await program.parseAsync([
      'node',
      'restore-cli',
      'recover',
      '--repository',
      '/repo',
      '--repository-id',
      'repo-id',
      '--protection',
      'plaintext',
      '--staging-root',
      '/staging',
      '--install-phase',
      'vscode',
    ])
    const output = JSON.parse(stdout[0] ?? '')
    expect(output).toMatchObject({
      operation: 'recovery-install',
      category: 'internal',
      issues: [{ code: 'RECOVERY_INSTALL_FAILED' }],
    })
    expect(JSON.stringify(output)).not.toContain('/Users/alice')
  })

  it('emits the complete stable planning failure schema for a missing input', async () => {
    const stdout: string[] = []
    const missing = Object.assign(new Error('/Users/alice/private/repository'), { code: 'ENOENT' })
    const program = new Command()
    registerRecoverCommand(program, {
      plan: async () => {
        throw missing
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })
    await program.parseAsync([
      'node',
      'restore-cli',
      'recover',
      '--repository',
      '/secret/repo',
      '--repository-id',
      'repo-id',
      '--protection',
      'plaintext',
      '--staging-root',
      '/secret/staging',
    ])
    const output = JSON.parse(stdout[0] ?? '') as Record<string, unknown>
    expect(Object.keys(output)).toEqual([
      'formatVersion',
      'operation',
      'state',
      'category',
      'dryRun',
      'startedAt',
      'endedAt',
      'repository',
      'recoveryPoint',
      'staging',
      'configuration',
      'software',
      'allowlistedActions',
      'manualDependencies',
      'phases',
      'fingerprint',
      'issues',
      'nextAction',
    ])
    expect(output).toMatchObject({
      operation: 'recovery-plan',
      state: 'failure',
      category: 'configuration',
      repository: { path: null, id: 'repo-id', authenticated: false },
      recoveryPoint: { healthy: false, fixed: false, contentVerified: false },
      staging: { id: null, path: null, verified: false },
      issues: [{ code: 'RECOVERY_INPUT_MISSING', category: 'configuration' }],
    })
    expect(JSON.stringify(output)).not.toContain('/secret')
    expect(JSON.stringify(output)).not.toContain('/Users/alice')
  })

  it('emits the complete stable install failure schema when resume state is missing', async () => {
    const stdout: string[] = []
    const program = new Command()
    registerRecoverCommand(program, {
      install: async () => {
        throw new RecoveryPlanError(
          'configuration',
          'PRIVATE_INSTALL_STATE_REQUIRED',
          '/Users/alice/private/state is missing',
        )
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })
    await program.parseAsync([
      'node',
      'restore-cli',
      'recover',
      '--repository',
      '/repo',
      '--repository-id',
      'repo-id',
      '--protection',
      'plaintext',
      '--staging-root',
      '/staging',
      '--point',
      'point-id',
      '--install-phase',
      'vscode',
      '--execute-install',
      '--approve-plan',
      'c'.repeat(64),
    ])
    const output = JSON.parse(stdout[0] ?? '') as Record<string, unknown>
    expect(Object.keys(output)).toEqual([
      'operation',
      'state',
      'category',
      'dryRun',
      'startedAt',
      'endedAt',
      'repositoryId',
      'pointId',
      'planFingerprint',
      'items',
      'counts',
      'issues',
      'nextAction',
    ])
    expect(output).toMatchObject({
      operation: 'recovery-install',
      state: 'failure',
      category: 'configuration',
      dryRun: false,
      repositoryId: 'repo-id',
      pointId: 'point-id',
      planFingerprint: 'c'.repeat(64),
      items: [],
      counts: { total: 0, failed: 0, manual: 0 },
      issues: [{ code: 'PRIVATE_INSTALL_STATE_REQUIRED', category: 'configuration' }],
    })
    expect(JSON.stringify(output)).not.toContain('/Users/alice')
  })

  it.each([
    ['malformed', '{'],
    ['oversized', 'x'.repeat(MAX_INSTALL_JOURNAL_BYTES + 1)],
  ])(
    'maps an actual %s private install journal to a stable integrity failure',
    async (_label, payload) => {
      const fixture = await createRecoveryPlanFixture()
      roots.push(fixture.root)
      const generated = await generateRecoveryPlan(fixture.options, {
        collectCurrentInventory: async () => fixture.current,
      })
      const executeOptions = {
        ...fixture.options,
        stateDirectory: fixture.stateDirectory,
        phases: ['vscode'] as const,
        confirmedPhases: ['vscode'] as const,
        execute: true,
        invocation: 'interactive-cli' as const,
        approvedPlanFingerprint: generated.fingerprint,
      }
      await executeRecoveryInstallPlan(
        {
          ...executeOptions,
          phases: [...executeOptions.phases],
          confirmedPhases: [...executeOptions.confirmedPhases],
        },
        {
          generatePlan: async () => generated,
          collectCurrentInventory: async () => fixture.current,
          lockRoot: fixture.lockRoot,
          commandRunner: async () => {
            throw new RecoveryPlanError(
              'internal',
              'INSTALLER_COMMAND_FAILED',
              'fixture command failure',
            )
          },
        },
      )
      const journalPath = join(
        fixture.stateDirectory,
        recoveryInstallJournalBasename(generated.fingerprint, ['vscode']),
      )
      await writeFile(journalPath, payload)

      const stdout: string[] = []
      const program = new Command()
      registerRecoverCommand(program, {
        install: (options) =>
          executeRecoveryInstallPlan(options, {
            generatePlan: async () => generated,
            collectCurrentInventory: async () => fixture.current,
            lockRoot: fixture.lockRoot,
          }),
        writeStdout: (value) => stdout.push(value),
        writeStderr: () => undefined,
        setExitCode: () => undefined,
      })
      await program.parseAsync([
        'node',
        'restore-cli',
        'recover',
        '--repository',
        fixture.options.repositoryPath,
        '--repository-id',
        fixture.options.expectedRepositoryId,
        '--protection',
        'plaintext',
        '--staging-root',
        fixture.options.stagingRoot,
        '--point',
        fixture.options.pointId as string,
        '--install-phase',
        'vscode',
        '--confirm-phase',
        'vscode',
        '--execute-install',
        '--approve-plan',
        generated.fingerprint,
        '--state-directory',
        fixture.stateDirectory,
      ])
      const output = JSON.parse(stdout[0] ?? '')
      expect(output).toMatchObject({
        operation: 'recovery-install',
        state: 'failure',
        category: 'integrity',
        issues: [{ code: 'INSTALL_JOURNAL_INVALID', category: 'integrity' }],
      })
      expect(JSON.stringify(output)).not.toContain(fixture.root)
    },
  )

  it.each([
    ['missing', false],
    ['malformed', true],
  ])(
    'maps an actual %s independent recovery credential to authentication',
    async (_label, createMalformed) => {
      const root = await mkdtemp(join(tmpdir(), 'restore-cli-credential-'))
      roots.push(root)
      const recoveryFile = join(root, 'recovery.secret')
      if (createMalformed) await writeFile(recoveryFile, 'not-a-recovery-secret')
      const stdout: string[] = []
      const program = new Command()
      registerRecoverCommand(program, {
        plan: async (options) => {
          await options.credentialProvider?.loadMasterKey('repo-id')
          return plan()
        },
        writeStdout: (value) => stdout.push(value),
        writeStderr: () => undefined,
        setExitCode: () => undefined,
      })
      await program.parseAsync([
        'node',
        'restore-cli',
        'recover',
        '--repository',
        join(root, 'repository'),
        '--repository-id',
        'repo-id',
        '--protection',
        'encrypted',
        '--recovery-file',
        recoveryFile,
        '--staging-root',
        join(root, 'staging'),
      ])
      expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
        operation: 'recovery-plan',
        category: 'authentication',
        issues: [{ code: 'RECOVERY_AUTHENTICATION_FAILED', category: 'authentication' }],
      })
      expect(JSON.stringify(JSON.parse(stdout[0] ?? ''))).not.toContain(root)
    },
  )

  it('maps actual wrapped-key JSON corruption to integrity without leaking paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restore-cli-wrapper-'))
    roots.push(root)
    const repository = join(root, 'repository')
    const layout = getRepositoryLayout(repository)
    await mkdir(layout.keys, { recursive: true })
    await writeFile(layout.recoveryKey, '{invalid-json')
    const recoveryFile = join(root, 'recovery.secret')
    const secret = generateRecoverySecret()
    try {
      await writeFile(recoveryFile, exportRecoverySecret(secret))
    } finally {
      secret.dispose()
    }
    const stdout: string[] = []
    const program = new Command()
    registerRecoverCommand(program, {
      plan: async (options) => {
        await options.credentialProvider?.loadMasterKey('repo-id')
        return plan()
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })
    await program.parseAsync([
      'node',
      'restore-cli',
      'recover',
      '--repository',
      repository,
      '--repository-id',
      'repo-id',
      '--protection',
      'encrypted',
      '--recovery-file',
      recoveryFile,
      '--staging-root',
      join(root, 'staging'),
    ])
    const output = JSON.parse(stdout[0] ?? '')
    expect(output).toMatchObject({
      operation: 'recovery-plan',
      category: 'integrity',
      issues: [{ code: 'RECOVERY_PROTECTION_FAILED', category: 'integrity' }],
    })
    expect(JSON.stringify(output)).not.toContain(root)
  })

  it('maps an actual tampered-staging authentication failure without leaking its path', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const recoveryPlan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const descriptor = await readStagingDescriptor(recoveryPlan.staging.path)
    const entry = descriptor.entries.find((candidate) => candidate.type === 'file')
    if (!entry) throw new Error('missing staged file fixture')
    await writeFile(join(recoveryPlan.staging.path, entry.stagingRelativePath), 'tampered')
    const stdout: string[] = []
    const program = new Command()
    registerRecoverCommand(program, {
      install: async () => {
        await authenticateStaging(
          {
            repositoryPath: fixture.options.repositoryPath,
            expectedRepositoryId: fixture.options.expectedRepositoryId,
            expectedProtection: fixture.options.expectedProtection,
          },
          recoveryPlan.staging.path,
        )
        throw new Error('tampered staging unexpectedly authenticated')
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })
    await program.parseAsync([
      'node',
      'restore-cli',
      'recover',
      '--repository',
      fixture.options.repositoryPath,
      '--repository-id',
      fixture.options.expectedRepositoryId,
      '--protection',
      'plaintext',
      '--staging-root',
      fixture.options.stagingRoot,
      '--install-phase',
      'vscode',
    ])
    const output = JSON.parse(stdout[0] ?? '')
    expect(output).toMatchObject({
      operation: 'recovery-install',
      category: 'integrity',
    })
    expect(output.issues[0].code).toMatch(/^STAGING_|^STAGED_/)
    expect(JSON.stringify(output)).not.toContain(fixture.root)
  })
})

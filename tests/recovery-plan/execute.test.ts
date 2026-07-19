import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_INSTALL_JOURNAL_BYTES,
  MAX_INSTALL_JOURNAL_ITEMS,
  RecoveryPlanError,
  executeRecoveryInstallPlan,
  generateRecoveryPlan,
  recoveryInstallJournalBasename,
  recoveryInstallLeaseBasename,
  runInstallerCommand,
} from '../../src/recovery-plan/index.js'
import { createRecoveryPlanFixture } from './fixture.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('controlled recovery installers', () => {
  it('defaults to dry-run and invokes no installer process', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const runner = vi.fn()
    const result = await executeRecoveryInstallPlan(
      { ...fixture.options, stateDirectory: fixture.stateDirectory, phases: ['vscode'] },
      { generatePlan: async () => plan, commandRunner: runner },
    )
    expect(result).toMatchObject({ dryRun: true, state: 'warning', category: 'warning' })
    expect(result.items.filter((item) => item.phase === 'vscode')).toSatisfy(
      (items: typeof result.items) => items.every((item) => item.status === 'pending'),
    )
    expect(runner).not.toHaveBeenCalled()
  })

  it('requires exact approval and explicit confirmation before any process', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const runner = vi.fn()
    await expect(
      executeRecoveryInstallPlan(
        {
          ...fixture.options,
          stateDirectory: fixture.stateDirectory,
          phases: ['vscode'],
          execute: true,
          invocation: 'interactive-cli',
          approvedPlanFingerprint: plan.fingerprint,
        },
        { generatePlan: async () => plan, commandRunner: runner },
      ),
    ).rejects.toMatchObject({
      code: 'PHASE_CONFIRMATION_REQUIRED',
    } satisfies Partial<RecoveryPlanError>)
    expect(runner).not.toHaveBeenCalled()
  })

  it('persists each VS Code action and resumes only failed work', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const firstRunner = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 23 })
    const options = {
      ...fixture.options,
      stateDirectory: fixture.stateDirectory,
      phases: ['vscode'] as const,
      confirmedPhases: ['vscode'] as const,
      execute: true,
      invocation: 'interactive-cli' as const,
      approvedPlanFingerprint: plan.fingerprint,
    }
    const first = await executeRecoveryInstallPlan(
      { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
      {
        generatePlan: async () => plan,
        commandRunner: firstRunner,
        collectCurrentInventory: async () => fixture.current,
      },
    )
    expect(first.state).toBe('partial')
    expect(
      first.items.filter((item) => item.phase === 'vscode').map((item) => item.status),
    ).toEqual(['succeeded', 'failed'])
    const secondCalls: Array<{ executable: string; args: readonly string[] }> = []
    const secondRunner = async (executable: string, args: readonly string[]) => {
      secondCalls.push({ executable, args })
      return { exitCode: 0 }
    }
    const resumed = await executeRecoveryInstallPlan(
      { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
      {
        generatePlan: async () => plan,
        commandRunner: secondRunner,
        collectCurrentInventory: async () => fixture.current,
      },
    )
    expect(resumed.state).toBe('warning')
    expect(secondCalls).toHaveLength(1)
    expect(secondCalls[0]?.args).toEqual(['--install-extension', 'esbenp.prettier-vscode'])
  })

  it('rejects a journal action tampered outside authenticated inventory', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const options = {
      ...fixture.options,
      stateDirectory: fixture.stateDirectory,
      phases: ['vscode'] as const,
      confirmedPhases: ['vscode'] as const,
      execute: true,
      invocation: 'interactive-cli' as const,
      approvedPlanFingerprint: plan.fingerprint,
    }
    await executeRecoveryInstallPlan(
      { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
      {
        generatePlan: async () => plan,
        commandRunner: async () => ({ exitCode: 20 }),
        collectCurrentInventory: async () => fixture.current,
      },
    )
    const journalPath = join(
      fixture.stateDirectory,
      recoveryInstallJournalBasename(plan.fingerprint, ['vscode']),
    )
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      items: Array<{ id: string; value: string }>
    }
    const item = journal.items.find((candidate) => candidate.id.startsWith('vscode-extension:'))
    if (!item) throw new Error('missing fixture item')
    item.value = 'evil.extension'
    item.id = 'vscode-extension:evil.extension'
    await writeFile(journalPath, JSON.stringify(journal))
    const runner = vi.fn()
    await expect(
      executeRecoveryInstallPlan(
        { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
        {
          generatePlan: async () => plan,
          commandRunner: runner,
          collectCurrentInventory: async () => fixture.current,
        },
      ),
    ).rejects.toMatchObject({
      code: 'INSTALL_JOURNAL_ACTION_SET_MISMATCH',
    } satisfies Partial<RecoveryPlanError>)
    expect(runner).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed JSON', '{'],
    ['oversized payload', 'x'.repeat(MAX_INSTALL_JOURNAL_BYTES + 1)],
  ])('maps %s resume journals to stable integrity errors', async (_label, payload) => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const options = {
      ...fixture.options,
      stateDirectory: fixture.stateDirectory,
      phases: ['vscode'] as const,
      confirmedPhases: ['vscode'] as const,
      execute: true,
      invocation: 'interactive-cli' as const,
      approvedPlanFingerprint: plan.fingerprint,
    }
    await executeRecoveryInstallPlan(
      { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
      {
        generatePlan: async () => plan,
        commandRunner: async () => ({ exitCode: 20 }),
        collectCurrentInventory: async () => fixture.current,
        lockRoot: fixture.lockRoot,
      },
    )
    const journalPath = join(
      fixture.stateDirectory,
      recoveryInstallJournalBasename(plan.fingerprint, ['vscode']),
    )
    await writeFile(journalPath, payload)
    const runner = vi.fn()
    await expect(
      executeRecoveryInstallPlan(
        { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
        {
          generatePlan: async () => plan,
          commandRunner: runner,
          collectCurrentInventory: async () => fixture.current,
          lockRoot: fixture.lockRoot,
        },
      ),
    ).rejects.toMatchObject({ category: 'integrity', code: 'INSTALL_JOURNAL_INVALID' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('forbids daemon execution before planning or process invocation', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const generate = vi.fn()
    const runner = vi.fn()
    await expect(
      executeRecoveryInstallPlan(
        {
          ...fixture.options,
          stateDirectory: fixture.stateDirectory,
          phases: ['homebrew'],
          execute: true,
          invocation: 'daemon',
          approvedPlanFingerprint: 'a'.repeat(64),
          confirmedPhases: ['homebrew'],
        },
        { generatePlan: generate, commandRunner: runner },
      ),
    ).rejects.toMatchObject({
      code: 'DAEMON_INSTALL_FORBIDDEN',
    } satisfies Partial<RecoveryPlanError>)
    expect(generate).not.toHaveBeenCalled()
    expect(runner).not.toHaveBeenCalled()
  })

  it('runs each Homebrew item with a newly synthesized one-action Brewfile', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const brewfiles: string[] = []
    const brewfilePaths: string[] = []
    const runner = async (_executable: string, args: readonly string[]) => {
      brewfilePaths.push(args[2] as string)
      brewfiles.push(await readFile(args[2] as string, 'utf8'))
      return { exitCode: 0 }
    }
    const result = await executeRecoveryInstallPlan(
      {
        ...fixture.options,
        stateDirectory: fixture.stateDirectory,
        phases: ['homebrew'],
        confirmedPhases: ['homebrew'],
        execute: true,
        invocation: 'interactive-cli',
        approvedPlanFingerprint: plan.fingerprint,
      },
      {
        generatePlan: async () => plan,
        commandRunner: runner,
        collectCurrentInventory: async () => fixture.current,
      },
    )
    expect(result.state).toBe('warning')
    expect(brewfiles).toHaveLength(2)
    expect(new Set(brewfilePaths).size).toBe(2)
    expect(brewfiles[0]).toContain('cask "iterm2"')
    expect(brewfiles[0]).not.toContain('brew "node"')
    expect(brewfiles[1]).toContain('brew "node"')
    expect(brewfiles[1]).not.toContain('cask "iterm2"')
  })

  it('marks externally completed pending work already-present and does not rerun it', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const runner = vi.fn()
    const current = {
      ...fixture.current,
      vscode: {
        available: true,
        extensions: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'],
      },
    }
    const result = await executeRecoveryInstallPlan(
      {
        ...fixture.options,
        stateDirectory: fixture.stateDirectory,
        phases: ['vscode'],
        confirmedPhases: ['vscode'],
        execute: true,
        invocation: 'interactive-cli',
        approvedPlanFingerprint: plan.fingerprint,
      },
      {
        generatePlan: async () => plan,
        commandRunner: runner,
        collectCurrentInventory: async () => current,
      },
    )
    expect(
      result.items.filter((item) => item.phase === 'vscode').map((item) => item.status),
    ).toEqual(['already-present', 'already-present'])
    expect(runner).not.toHaveBeenCalled()
  })

  it('holds an exclusive same-plan lease while an installer command is running', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started: (() => void) | undefined
    const commandStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const options = {
      ...fixture.options,
      stateDirectory: fixture.stateDirectory,
      phases: ['vscode'] as const,
      confirmedPhases: ['vscode'] as const,
      execute: true,
      invocation: 'interactive-cli' as const,
      approvedPlanFingerprint: plan.fingerprint,
    }
    const first = executeRecoveryInstallPlan(
      { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
      {
        generatePlan: async () => plan,
        collectCurrentInventory: async () => fixture.current,
        commandRunner: async () => {
          started?.()
          await blocked
          return { exitCode: 0 }
        },
      },
    )
    await commandStarted
    const runner = vi.fn(async () => ({ exitCode: 0 }))
    await expect(
      executeRecoveryInstallPlan(
        { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
        {
          generatePlan: async () => plan,
          collectCurrentInventory: async () => fixture.current,
          commandRunner: runner,
        },
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_INSTALL_ALREADY_RUNNING' })
    expect(runner).not.toHaveBeenCalled()
    release?.()
    await first
  })

  it('requires a current-user private state directory before creating a journal', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    await import('node:fs/promises').then(({ chmod }) => chmod(fixture.stateDirectory, 0o755))
    await expect(
      executeRecoveryInstallPlan(
        {
          ...fixture.options,
          stateDirectory: fixture.stateDirectory,
          phases: ['vscode'],
          confirmedPhases: ['vscode'],
          execute: true,
          invocation: 'interactive-cli',
          approvedPlanFingerprint: plan.fingerprint,
        },
        { generatePlan: async () => plan },
      ),
    ).rejects.toMatchObject({ code: 'PRIVATE_INSTALL_STATE_REQUIRED' })
  })

  it('requires explicit private state only for execution, not dry-run', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const dryRun = await executeRecoveryInstallPlan(
      { ...fixture.options, phases: ['vscode'] },
      { generatePlan: async () => plan },
    )
    expect(dryRun.dryRun).toBe(true)
    await expect(
      executeRecoveryInstallPlan(
        {
          ...fixture.options,
          phases: ['vscode'],
          confirmedPhases: ['vscode'],
          execute: true,
          invocation: 'interactive-cli',
          approvedPlanFingerprint: plan.fingerprint,
        },
        { generatePlan: async () => plan },
      ),
    ).rejects.toMatchObject({ code: 'PRIVATE_INSTALL_STATE_REQUIRED' })
  })

  it('quarantines a proven-dead exact stale lease and resumes normally', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const staleLease = join(
      fixture.lockRoot,
      recoveryInstallLeaseBasename(plan.repository.id, plan.recoveryPoint.id, plan.fingerprint),
    )
    await mkdir(staleLease, { mode: 0o700 })
    await writeFile(
      join(staleLease, 'owner.json'),
      JSON.stringify({
        owner: '00000000-0000-4000-8000-000000000001',
        pid: 2_147_483_647,
        createdAt: '2020-01-01T00:00:00.000Z',
        activeCommand: null,
      }),
      { mode: 0o600 },
    )
    const result = await executeRecoveryInstallPlan(
      {
        ...fixture.options,
        stateDirectory: fixture.stateDirectory,
        phases: ['vscode'],
        confirmedPhases: ['vscode'],
        execute: true,
        invocation: 'interactive-cli',
        approvedPlanFingerprint: plan.fingerprint,
      },
      {
        generatePlan: async () => plan,
        collectCurrentInventory: async () => fixture.current,
        commandRunner: async () => ({ exitCode: 0 }),
        lockRoot: fixture.lockRoot,
      },
    )
    expect(result.state).toBe('warning')
  })

  it('uses one plan-wide lock across phases and alternate journal directories', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const alternateState = join(fixture.root, 'alternate-state')
    await mkdir(alternateState, { mode: 0o700 })
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started: (() => void) | undefined
    const commandStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const first = executeRecoveryInstallPlan(
      {
        ...fixture.options,
        stateDirectory: fixture.stateDirectory,
        phases: ['vscode'],
        confirmedPhases: ['vscode'],
        execute: true,
        invocation: 'interactive-cli',
        approvedPlanFingerprint: plan.fingerprint,
      },
      {
        generatePlan: async () => plan,
        collectCurrentInventory: async () => fixture.current,
        lockRoot: fixture.lockRoot,
        commandRunner: async () => {
          started?.()
          await blocked
          return { exitCode: 0 }
        },
      },
    )
    await commandStarted
    await expect(
      executeRecoveryInstallPlan(
        {
          ...fixture.options,
          stateDirectory: alternateState,
          phases: ['homebrew'],
          confirmedPhases: ['homebrew'],
          execute: true,
          invocation: 'interactive-cli',
          approvedPlanFingerprint: plan.fingerprint,
        },
        {
          generatePlan: async () => plan,
          collectCurrentInventory: async () => fixture.current,
          lockRoot: fixture.lockRoot,
          commandRunner: async () => ({ exitCode: 0 }),
        },
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_INSTALL_ALREADY_RUNNING' })
    release?.()
    await first
  })

  it('never clears a dead-parent lease while its recorded installer child is alive', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const leasePath = join(
      fixture.lockRoot,
      recoveryInstallLeaseBasename(plan.repository.id, plan.recoveryPoint.id, plan.fingerprint),
    )
    await mkdir(leasePath, { mode: 0o700 })
    await writeFile(
      join(leasePath, 'owner.json'),
      `${JSON.stringify({
        owner: '00000000-0000-4000-8000-000000000002',
        pid: 2_147_483_647,
        createdAt: '2020-01-01T00:00:00.000Z',
        activeCommand: {
          state: 'running',
          pid: process.pid,
          expiresAt: '2020-01-01T00:00:01.000Z',
        },
      })}\n`,
      { mode: 0o600 },
    )
    const runner = vi.fn()
    await expect(
      executeRecoveryInstallPlan(
        {
          ...fixture.options,
          stateDirectory: fixture.stateDirectory,
          phases: ['vscode'],
          confirmedPhases: ['vscode'],
          execute: true,
          invocation: 'interactive-cli',
          approvedPlanFingerprint: plan.fingerprint,
        },
        {
          generatePlan: async () => plan,
          collectCurrentInventory: async () => fixture.current,
          lockRoot: fixture.lockRoot,
          commandRunner: runner,
        },
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_INSTALL_ALREADY_RUNNING' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('refuses stale quarantine when the full owner record mutates in place', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const leasePath = join(
      fixture.lockRoot,
      recoveryInstallLeaseBasename(plan.repository.id, plan.recoveryPoint.id, plan.fingerprint),
    )
    const ownerPath = join(leasePath, 'owner.json')
    await mkdir(leasePath, { mode: 0o700 })
    const owner = {
      owner: '00000000-0000-4000-8000-000000000003',
      pid: 2_147_483_647,
      createdAt: '2020-01-01T00:00:00.000Z',
      activeCommand: null,
    }
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 })
    const runner = vi.fn()
    await expect(
      executeRecoveryInstallPlan(
        {
          ...fixture.options,
          stateDirectory: fixture.stateDirectory,
          phases: ['vscode'],
          confirmedPhases: ['vscode'],
          execute: true,
          invocation: 'interactive-cli',
          approvedPlanFingerprint: plan.fingerprint,
        },
        {
          generatePlan: async () => plan,
          collectCurrentInventory: async () => fixture.current,
          lockRoot: fixture.lockRoot,
          commandRunner: runner,
          beforeStaleLeaseQuarantine: async () => {
            await writeFile(
              ownerPath,
              `${JSON.stringify({ ...owner, owner: '00000000-0000-4000-8000-000000000004' })}\n`,
            )
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_INSTALL_ALREADY_RUNNING' })
    expect(await readFile(ownerPath, 'utf8')).toContain('000000000004')
    expect(runner).not.toHaveBeenCalled()
  })

  it('publishes only a complete lease and cleans its own pre-publish crash residue', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const finalPath = join(
      fixture.lockRoot,
      recoveryInstallLeaseBasename(plan.repository.id, plan.recoveryPoint.id, plan.fingerprint),
    )
    await expect(
      executeRecoveryInstallPlan(
        {
          ...fixture.options,
          stateDirectory: fixture.stateDirectory,
          phases: ['vscode'],
          confirmedPhases: ['vscode'],
          execute: true,
          invocation: 'interactive-cli',
          approvedPlanFingerprint: plan.fingerprint,
        },
        {
          generatePlan: async () => plan,
          collectCurrentInventory: async () => fixture.current,
          lockRoot: fixture.lockRoot,
          beforeInstallLeasePublish: async (pendingPath, requestedFinalPath) => {
            expect(requestedFinalPath).toBe(finalPath)
            await expect(lstat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
            expect(await readdir(pendingPath)).toEqual(['owner.json'])
            throw new Error('simulated acquisition crash')
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_INSTALL_LEASE_FAILED' })
    expect(await readdir(fixture.lockRoot)).toEqual([])
  })

  it('allows only one competing complete lease publication and cleans the loser pending dir', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    let allowFirstPublish: (() => void) | undefined
    const firstPublishBlocked = new Promise<void>((resolve) => {
      allowFirstPublish = resolve
    })
    let firstPendingReady: (() => void) | undefined
    const firstPending = new Promise<void>((resolve) => {
      firstPendingReady = resolve
    })
    let releaseWinner: (() => void) | undefined
    const winnerBlocked = new Promise<void>((resolve) => {
      releaseWinner = resolve
    })
    let winnerStarted: (() => void) | undefined
    const winnerCommand = new Promise<void>((resolve) => {
      winnerStarted = resolve
    })
    const options = {
      ...fixture.options,
      stateDirectory: fixture.stateDirectory,
      phases: ['vscode'] as const,
      confirmedPhases: ['vscode'] as const,
      execute: true,
      invocation: 'interactive-cli' as const,
      approvedPlanFingerprint: plan.fingerprint,
    }
    const first = executeRecoveryInstallPlan(
      { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
      {
        generatePlan: async () => plan,
        collectCurrentInventory: async () => fixture.current,
        lockRoot: fixture.lockRoot,
        beforeInstallLeasePublish: async () => {
          firstPendingReady?.()
          await firstPublishBlocked
        },
        commandRunner: async () => ({ exitCode: 0 }),
      },
    ).then(
      () => null,
      (error: unknown) => error,
    )
    await firstPending
    const winner = executeRecoveryInstallPlan(
      { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
      {
        generatePlan: async () => plan,
        collectCurrentInventory: async () => fixture.current,
        lockRoot: fixture.lockRoot,
        commandRunner: async () => {
          winnerStarted?.()
          await winnerBlocked
          return { exitCode: 0 }
        },
      },
    )
    await winnerCommand
    allowFirstPublish?.()
    expect(await first).toMatchObject({ code: 'RECOVERY_INSTALL_ALREADY_RUNNING' })
    expect(
      (await readdir(fixture.lockRoot)).filter((name) => name.startsWith('.pending-')),
    ).toEqual([])
    releaseWinner?.()
    await winner
  })

  it('never quarantines an expired dead-parent launch-pending manual wedge', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const leasePath = join(
      fixture.lockRoot,
      recoveryInstallLeaseBasename(plan.repository.id, plan.recoveryPoint.id, plan.fingerprint),
    )
    await mkdir(leasePath, { mode: 0o700 })
    await writeFile(
      join(leasePath, 'owner.json'),
      `${JSON.stringify({
        owner: '00000000-0000-4000-8000-000000000005',
        pid: 2_147_483_647,
        createdAt: '2020-01-01T00:00:00.000Z',
        activeCommand: {
          state: 'launch-pending',
          pid: 2_147_483_646,
          startedAt: '2020-01-01T00:00:00.000Z',
        },
      })}\n`,
      { mode: 0o600 },
    )
    const runner = vi.fn()
    await expect(
      executeRecoveryInstallPlan(
        {
          ...fixture.options,
          stateDirectory: fixture.stateDirectory,
          phases: ['vscode'],
          confirmedPhases: ['vscode'],
          execute: true,
          invocation: 'interactive-cli',
          approvedPlanFingerprint: plan.fingerprint,
        },
        {
          generatePlan: async () => plan,
          collectCurrentInventory: async () => fixture.current,
          lockRoot: fixture.lockRoot,
          commandRunner: runner,
        },
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_INSTALL_ALREADY_RUNNING' })
    const owner = JSON.parse(await readFile(join(leasePath, 'owner.json'), 'utf8'))
    expect(owner.activeCommand).toEqual({
      state: 'launch-pending',
      pid: 2_147_483_646,
      startedAt: '2020-01-01T00:00:00.000Z',
    })
    expect(runner).not.toHaveBeenCalled()
    expect((await readdir(fixture.lockRoot)).some((name) => name.startsWith('.stale-'))).toBe(false)
  })

  it('stops later work and preserves the active lease when a child cannot be reaped', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const leasePath = join(
      fixture.lockRoot,
      recoveryInstallLeaseBasename(plan.repository.id, plan.recoveryPoint.id, plan.fingerprint),
    )
    const runner = vi.fn(async (_executable, _args, _limits, lifecycle) => {
      await lifecycle?.childStarted(process.pid, '2026-07-19T00:05:15.000Z')
      throw new RecoveryPlanError(
        'internal',
        'INSTALLER_CHILD_UNREAPED',
        'simulated unreaped installer',
      )
    })
    const options = {
      ...fixture.options,
      stateDirectory: fixture.stateDirectory,
      phases: ['vscode'] as const,
      confirmedPhases: ['vscode'] as const,
      execute: true,
      invocation: 'interactive-cli' as const,
      approvedPlanFingerprint: plan.fingerprint,
    }
    await expect(
      executeRecoveryInstallPlan(
        { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
        {
          generatePlan: async () => plan,
          collectCurrentInventory: async () => fixture.current,
          lockRoot: fixture.lockRoot,
          commandRunner: runner,
        },
      ),
    ).rejects.toMatchObject({ code: 'INSTALLER_CHILD_UNREAPED' })
    expect(runner).toHaveBeenCalledTimes(1)
    const owner = JSON.parse(await readFile(join(leasePath, 'owner.json'), 'utf8'))
    expect(owner.activeCommand).toMatchObject({ state: 'running', pid: process.pid })
    await expect(
      executeRecoveryInstallPlan(
        { ...options, phases: [...options.phases], confirmedPhases: [...options.confirmedPhases] },
        {
          generatePlan: async () => plan,
          collectCurrentInventory: async () => fixture.current,
          lockRoot: fixture.lockRoot,
          commandRunner: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_INSTALL_ALREADY_RUNNING' })
  })

  it('preserves launch-pending when durable child-PID publication fails', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const leasePath = join(
      fixture.lockRoot,
      recoveryInstallLeaseBasename(plan.repository.id, plan.recoveryPoint.id, plan.fingerprint),
    )
    const runner = vi.fn(async (_executable, _args, _limits, lifecycle) => {
      await lifecycle?.childStarted(process.pid, '2026-07-19T00:05:15.000Z')
      return { exitCode: 0 }
    })
    await expect(
      executeRecoveryInstallPlan(
        {
          ...fixture.options,
          stateDirectory: fixture.stateDirectory,
          phases: ['vscode'],
          confirmedPhases: ['vscode'],
          execute: true,
          invocation: 'interactive-cli',
          approvedPlanFingerprint: plan.fingerprint,
        },
        {
          generatePlan: async () => plan,
          collectCurrentInventory: async () => fixture.current,
          lockRoot: fixture.lockRoot,
          commandRunner: runner,
          beforeInstallerChildPidPublish: async () => {
            throw new Error('simulated durable PID publication failure')
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'INSTALLER_CHILD_PID_PUBLICATION_FAILED' })
    expect(runner).toHaveBeenCalledTimes(1)
    const owner = JSON.parse(await readFile(join(leasePath, 'owner.json'), 'utf8'))
    expect(owner.activeCommand).toEqual({
      state: 'launch-pending',
      pid: process.pid,
      startedAt: '2026-07-19T00:00:00.000Z',
    })
  })

  it('keeps the launch sentinel active when child-PID publication fails and the child is unreaped', async () => {
    let childPid: number | undefined
    try {
      await expect(
        runInstallerCommand(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          { timeoutMs: 20_000, maxOutputBytes: 1024 },
          {
            launchPending: vi.fn(),
            childStarted: async (pid) => {
              childPid = pid
              throw new Error('simulated durable publication failure')
            },
            childStopped: vi.fn(),
          },
          { kill: () => true },
        ),
      ).rejects.toMatchObject({ code: 'INSTALLER_CHILD_UNREAPED' })
    } finally {
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {
          // The child may have exited independently.
        }
      }
    }
  })

  it('journals deterministic manual work without ever executing it', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const original = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const plan = {
      ...original,
      manualDependencies: [
        ...original.manualDependencies,
        {
          id: 'manual-dmg',
          kind: 'manual' as const,
          name: 'Vendor DMG',
          reason: 'Download manually',
        },
      ],
    }
    const runner = vi.fn()
    const result = await executeRecoveryInstallPlan(
      { ...fixture.options, phases: ['homebrew', 'vscode'] },
      { generatePlan: async () => plan, commandRunner: runner },
    )
    const manual = result.items.filter((item) => item.phase === 'manual')
    expect(manual.map((item) => item.id)).toEqual([...manual.map((item) => item.id)].sort())
    expect(manual.some((item) => item.id === 'manual-dependency:manual-dmg')).toBe(true)
    expect(manual.some((item) => item.id.startsWith('manual-software:mac-app:'))).toBe(true)
    expect(result).toMatchObject({
      state: 'warning',
      category: 'warning',
      counts: { manual: manual.length, total: result.items.length },
    })
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'MANUAL_RECOVERY_REQUIRED' }),
    )
    expect(runner).not.toHaveBeenCalled()
  })

  it('rejects item and encoded journal limits before any installer command', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const original = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    const runner = vi.fn()
    const tooMany = {
      ...original,
      manualDependencies: Array.from({ length: MAX_INSTALL_JOURNAL_ITEMS + 1 }, (_, index) => ({
        id: `manual-${index.toString().padStart(5, '0')}`,
        kind: 'manual' as const,
        name: 'Manual item',
        reason: 'Manual recovery',
      })),
    }
    await expect(
      executeRecoveryInstallPlan(
        { ...fixture.options, phases: ['vscode'] },
        { generatePlan: async () => tooMany, commandRunner: runner },
      ),
    ).rejects.toMatchObject({ code: 'INSTALL_JOURNAL_ITEM_LIMIT_EXCEEDED' })

    const tooLarge = {
      ...original,
      manualDependencies: [
        {
          id: 'oversized',
          kind: 'manual' as const,
          name: 'Oversized',
          reason: 'x'.repeat(MAX_INSTALL_JOURNAL_BYTES),
        },
      ],
    }
    await expect(
      executeRecoveryInstallPlan(
        { ...fixture.options, phases: ['vscode'] },
        { generatePlan: async () => tooLarge, commandRunner: runner },
      ),
    ).rejects.toMatchObject({ code: 'INSTALL_JOURNAL_BYTE_LIMIT_EXCEEDED' })
    expect(runner).not.toHaveBeenCalled()
  })
})

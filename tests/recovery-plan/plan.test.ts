import { readFile, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RecoveryPlanError, generateRecoveryPlan } from '../../src/recovery-plan/index.js'
import { assertCleanRecoveryStage } from '../../src/recovery-plan/plan.js'
import { createRecoveryPlanFixture } from './fixture.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('authenticated recovery planning', () => {
  it('stages and authenticates a healthy point, then reports config and missing software only', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const collect = vi.fn(async () => fixture.current)
    const plan = await generateRecoveryPlan(fixture.options, { collectCurrentInventory: collect })

    expect(plan).toMatchObject({
      operation: 'recovery-plan',
      state: 'partial',
      dryRun: true,
      repository: { authenticated: true, id: fixture.options.expectedRepositoryId },
      recoveryPoint: {
        id: 'healthy-point',
        healthy: true,
        fixed: true,
        contentVerified: true,
      },
      staging: { verified: false },
      configuration: { stagedOnly: true, originalPathsChanged: false },
    })
    expect(plan.allowlistedActions.map((action) => action.id)).toEqual([
      'homebrew-cask:iterm2',
      'homebrew-formula:node',
      'vscode-extension:dbaeumer.vscode-eslint',
      'vscode-extension:esbenp.prettier-vscode',
    ])
    expect(plan.software.find((item) => item.kind === 'mac-app')).toMatchObject({
      status: 'missing',
      recovery: 'manual',
    })
    expect(plan.software.find((item) => item.kind === 'raycast-extension')).toMatchObject({
      status: 'missing',
      recovery: 'manual',
    })
    expect(plan.phases.find((phase) => phase.id === 'configuration-apply')).toMatchObject({
      status: 'pending',
      requiresExplicitConfirmation: true,
    })
    expect(await readFile(plan.configuration.items[0]?.declaredPath as string, 'utf8')).toBe(
      'export PLAN_FIXTURE=1\n',
    )
    expect(collect).toHaveBeenCalledOnce()
  })

  it('produces a deterministic fingerprint for the same authenticated point and machine state', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const dependencies = { collectCurrentInventory: async () => fixture.current }
    const first = await generateRecoveryPlan(fixture.options, dependencies)
    const second = await generateRecoveryPlan(fixture.options, dependencies)
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it('rejects non-Apple-Silicon systems before repository or inventory access', async () => {
    const collect = vi.fn()
    await expect(
      generateRecoveryPlan(
        {
          repositoryPath: '/does/not/exist',
          expectedRepositoryId: 'not-read',
          expectedProtection: 'plaintext',
          stagingRoot: '/does/not/exist',
          platform: 'darwin',
          architecture: 'x64',
        },
        { collectCurrentInventory: collect },
      ),
    ).rejects.toMatchObject({ code: 'APPLE_SILICON_REQUIRED' } satisfies Partial<RecoveryPlanError>)
    expect(collect).not.toHaveBeenCalled()
  })

  it('keeps packages manual and creates no actions when an installer CLI is unavailable', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const current = {
      ...fixture.current,
      homebrew: { available: false, taps: [], formulae: [], casks: [] },
      vscode: { available: false, extensions: [] },
    }
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => current,
    })
    expect(plan.allowlistedActions).toEqual([])
    expect(plan.software.filter((item) => item.status === 'missing')).toSatisfy(
      (items: typeof plan.software) => items.every((item) => item.recovery === 'manual'),
    )
    expect(plan.manualDependencies.map((item) => item.id)).toEqual([
      'homebrew-cli-missing',
      'vscode-cli-missing',
    ])
    expect(plan.phases.find((phase) => phase.id === 'homebrew-install')?.status).toBe('manual')
    expect(plan.phases.find((phase) => phase.id === 'vscode-install')?.status).toBe('manual')
  })

  it('continues verified config-first recovery when every app inventory family is absent', async () => {
    const fixture = await createRecoveryPlanFixture({ includeInventories: false })
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })

    expect(plan).toMatchObject({
      state: 'partial',
      recoveryPoint: { healthy: true, contentVerified: true },
      staging: { verified: false },
      configuration: { stagedOnly: true, originalPathsChanged: false },
      allowlistedActions: [],
    })
    expect(plan.phases.find((phase) => phase.id === 'configuration-verification')).toMatchObject({
      status: 'manual',
    })
    expect(plan.nextAction).toContain('before any configuration apply')
    expect(plan.configuration.items).toHaveLength(1)
    expect(plan.manualDependencies.map((item) => item.id)).toEqual([
      'homebrew-inventory-missing',
      'mac-apps-inventory-missing',
      'raycast-inventory-missing',
      'vscode-inventory-missing',
    ])
    expect(plan.phases.find((phase) => phase.id === 'homebrew-install')?.status).toBe('manual')
    expect(plan.phases.find((phase) => phase.id === 'vscode-install')?.status).toBe('manual')
  })

  it('marks installer phases completed when authenticated software is already present', async () => {
    const fixture = await createRecoveryPlanFixture()
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => ({
        ...fixture.current,
        homebrew: {
          available: true,
          taps: ['homebrew/cask'],
          formulae: ['git', 'node'],
          casks: ['iterm2'],
        },
        vscode: {
          available: true,
          extensions: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'],
        },
      }),
    })
    expect(plan.allowlistedActions).toEqual([])
    expect(plan.phases.find((phase) => phase.id === 'homebrew-install')?.status).toBe('completed')
    expect(plan.phases.find((phase) => phase.id === 'vscode-install')?.status).toBe('completed')
  })

  it('reports unknown current paths and unavailable point sources without claiming missing', async () => {
    const fixture = await createRecoveryPlanFixture({ includeMissingConfig: true })
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
      inspectCurrentPath: async () => 'unknown',
    })
    expect(plan.configuration.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'zsh:zshrc',
          currentState: 'unknown',
          sourceStatus: 'captured',
          recoveryState: 'available',
        }),
        expect.objectContaining({
          sourceId: 'git:config',
          currentState: 'unknown',
          sourceStatus: 'missing',
          recoveryState: 'unavailable',
          stagedEntryCount: 0,
        }),
      ]),
    )
    expect(plan.manualDependencies.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'config-current-zsh:zshrc-unknown',
        'config-current-git:config-unknown',
        'config-source-git:config-unavailable',
      ]),
    )
  })

  it('fails with integrity when a present captured inventory has invalid authenticated content', async () => {
    const fixture = await createRecoveryPlanFixture({ invalidMacAppsInventory: true })
    roots.push(fixture.root)
    await expect(
      generateRecoveryPlan(fixture.options, {
        collectCurrentInventory: async () => fixture.current,
      }),
    ).rejects.toMatchObject({
      code: 'AUTHENTICATED_INVENTORY_INVALID',
      category: 'integrity',
    })
  })

  it('rejects partial staging and authenticated staging issues without success laundering', () => {
    expect(() =>
      assertCleanRecoveryStage({
        state: 'partial',
        category: 'partial',
        issues: [
          { code: 'METADATA_LOSS', category: 'partial', message: 'Metadata was not restored' },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'METADATA_LOSS', category: 'partial' }))
  })

  it('keeps unmatched authenticated inventory sources as bounded manual dependencies', async () => {
    const fixture = await createRecoveryPlanFixture({ includeUnknownInventory: true })
    roots.push(fixture.root)
    const plan = await generateRecoveryPlan(fixture.options, {
      collectCurrentInventory: async () => fixture.current,
    })
    expect(plan.manualDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^inventory-source-[0-9a-f]{24}$/),
          name: 'unknown-inventory/applications',
        }),
      ]),
    )
  })
})

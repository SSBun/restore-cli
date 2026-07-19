import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { arch as currentArchitecture, platform as currentPlatform } from 'node:os'
import { resolve } from 'node:path'
import { ProtectionAuthenticationError, ProtectionError } from '../protection/index.js'
import { authenticateStaging, stageRecovery } from '../recovery/index.js'
import { readVerifiedFile } from '../recovery/safe-io.js'
import { RecoveryFailure } from '../recovery/stage.js'
import type { StagedEntry, StagingDescriptor } from '../recovery/types.js'
import { RepositoryError } from '../repository/index.js'
import { expandPath } from '../util/path.js'
import type { ManifestSourceV1, RecoveryPointManifestV1 } from '../verify/index.js'
import { collectCurrentMachineInventory } from './current.js'
import {
  compareExpectedInventory,
  parseAllowlistedBrewfile,
  parseAllowlistedVSCodeInventory,
  parseMacAppsInventory,
  parseRaycastInventory,
} from './inventory.js'
import type {
  ConfigComparisonItem,
  CurrentMachineInventory,
  ExpectedInventory,
  RecoveryPlan,
  RecoveryPlanApprovalSnapshot,
  RecoveryPlanOptions,
  RecoveryPlanPhase,
} from './types.js'
import { RecoveryPlanError } from './types.js'

const INVENTORY_SOURCES = {
  homebrew: ['homebrew', 'brewfile'],
  vscode: ['vscode-extensions', 'extensions'],
  macApps: ['mac-apps', 'applications'],
  raycast: ['raycast', 'extensions'],
} as const
const MAX_UNMATCHED_INVENTORY_SOURCES = 1_000

export interface RecoveryPlanDependencies {
  collectCurrentInventory?: () => Promise<CurrentMachineInventory>
  inspectCurrentPath?: (path: string) => Promise<'present' | 'missing' | 'unknown'>
}

export function assertCleanRecoveryStage(input: {
  state: string
  category: string
  issues: Array<{ code: string; category: RecoveryPlanError['category']; message: string }>
}): void {
  if (input.state === 'success' && input.category === 'success' && input.issues.length === 0) return
  const first = input.issues[0]
  throw new RecoveryPlanError(
    first?.category ?? 'integrity',
    first?.code ?? 'RECOVERY_STAGING_NOT_CLEAN',
    first?.message ?? 'Recovery staging did not complete without limitations',
  )
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function safeNow(now?: () => Date): Date {
  const value = now?.() ?? new Date()
  if (!Number.isFinite(value.getTime())) throw new Error('Invalid clock')
  return value
}

export function assertSupportedRecoverySystem(options: RecoveryPlanOptions): void {
  const platform = options.platform ?? currentPlatform()
  const architecture = options.architecture ?? currentArchitecture()
  if (platform !== 'darwin' || architecture !== 'arm64') {
    throw new RecoveryPlanError(
      'unsupported',
      'APPLE_SILICON_REQUIRED',
      'Recovery planning is supported only on Apple Silicon macOS',
    )
  }
}

function findInventorySource(
  manifest: RecoveryPointManifestV1,
  plugin: string,
  name: string,
): ManifestSourceV1 | undefined {
  const sources = manifest.sources.filter(
    (candidate) =>
      candidate.plugin === plugin &&
      candidate.name === name &&
      candidate.recoveryScope === 'inventory',
  )
  if (sources.length > 1) {
    throw new RecoveryPlanError(
      'integrity',
      'AUTHENTICATED_INVENTORY_AMBIGUOUS',
      `Authenticated ${plugin}/${name} inventory mapping is ambiguous`,
    )
  }
  return sources[0]?.status === 'captured' ? sources[0] : undefined
}

function findInventoryEntry(descriptor: StagingDescriptor, source: ManifestSourceV1): StagedEntry {
  const entries = descriptor.entries.filter((candidate) => candidate.sourceId === source.id)
  const entry = entries.find((candidate) => candidate.relativePath === '.')
  if (
    entries.length !== 1 ||
    !entry ||
    entry.type !== 'file' ||
    !entry.contentHash ||
    entry.metadata.size > 4 * 1024 * 1024
  ) {
    throw new RecoveryPlanError(
      'integrity',
      'AUTHENTICATED_INVENTORY_INVALID',
      `Authenticated ${source.plugin}/${source.name} inventory has an invalid staged shape`,
    )
  }
  return entry
}

async function readInventory(
  stagingPath: string,
  descriptor: StagingDescriptor,
  source: ManifestSourceV1,
): Promise<Buffer> {
  const entry = findInventoryEntry(descriptor, source)
  return readVerifiedFile(
    resolve(stagingPath, entry.stagingRelativePath),
    entry.metadata.size,
    entry.contentHash as string,
  )
}

async function loadAuthenticatedExpectedInventoryUnchecked(
  stagingPath: string,
  descriptor: StagingDescriptor,
  manifest: RecoveryPointManifestV1,
): Promise<ExpectedInventory> {
  const sources = {
    homebrew: findInventorySource(manifest, ...INVENTORY_SOURCES.homebrew),
    vscode: findInventorySource(manifest, ...INVENTORY_SOURCES.vscode),
    macApps: findInventorySource(manifest, ...INVENTORY_SOURCES.macApps),
    raycast: findInventorySource(manifest, ...INVENTORY_SOURCES.raycast),
  }
  const manual: ExpectedInventory['manual'] = []
  const knownInventoryIds = new Set(
    manifest.sources
      .filter(
        (source) =>
          source.recoveryScope === 'inventory' &&
          Object.values(INVENTORY_SOURCES).some(
            ([plugin, name]) => source.plugin === plugin && source.name === name,
          ),
      )
      .map((source) => source.id),
  )
  const unmatchedInventory = manifest.sources
    .filter((source) => source.recoveryScope === 'inventory' && !knownInventoryIds.has(source.id))
    .sort((left, right) => compare(left.id, right.id))
  if (unmatchedInventory.length > MAX_UNMATCHED_INVENTORY_SOURCES) {
    throw new RecoveryPlanError(
      'integrity',
      'INVENTORY_SOURCE_LIMIT_EXCEEDED',
      'Authenticated inventory source count exceeds the recovery-plan limit',
    )
  }
  for (const source of unmatchedInventory) {
    manual.push({
      id: `inventory-source-${createHash('sha256').update(source.id).digest('hex').slice(0, 24)}`,
      kind: 'manual',
      name: `${source.plugin}/${source.name}`,
      reason: `Authenticated inventory source ${source.plugin}/${source.name} has no automatic recovery mapping and remains manual`,
    })
  }
  const missing = (family: string, name: string): void => {
    manual.push({
      id: `${family}-inventory-missing`,
      kind: 'manual',
      name,
      reason: `No authenticated ${name} inventory is available in the selected recovery point`,
    })
  }
  let homebrew: ReturnType<typeof parseAllowlistedBrewfile> = {
    taps: [],
    formulae: [],
    casks: [],
    manual: [],
  }
  let vscode: ReturnType<typeof parseAllowlistedVSCodeInventory> = {
    extensions: [],
    manual: [],
  }
  let macApps: ExpectedInventory['macApps'] = []
  let raycastExtensions: ExpectedInventory['raycastExtensions'] = []

  if (sources.homebrew) {
    const buffer = await readInventory(stagingPath, descriptor, sources.homebrew)
    try {
      homebrew = parseAllowlistedBrewfile(buffer)
    } finally {
      buffer.fill(0)
    }
  } else missing('homebrew', 'Homebrew')

  if (sources.vscode) {
    const buffer = await readInventory(stagingPath, descriptor, sources.vscode)
    try {
      vscode = parseAllowlistedVSCodeInventory(buffer)
    } finally {
      buffer.fill(0)
    }
  } else missing('vscode', 'VS Code extensions')

  if (sources.macApps) {
    const buffer = await readInventory(stagingPath, descriptor, sources.macApps)
    try {
      macApps = parseMacAppsInventory(buffer)
    } finally {
      buffer.fill(0)
    }
  } else missing('mac-apps', 'Mac applications')

  if (sources.raycast) {
    const buffer = await readInventory(stagingPath, descriptor, sources.raycast)
    try {
      raycastExtensions = parseRaycastInventory(buffer)
    } finally {
      buffer.fill(0)
    }
  } else missing('raycast', 'Raycast extensions')

  return {
    homebrew: {
      taps: homebrew.taps,
      formulae: homebrew.formulae,
      casks: homebrew.casks,
    },
    vscodeExtensions: vscode.extensions,
    macApps,
    raycastExtensions,
    manual: [...manual, ...homebrew.manual, ...vscode.manual].sort((left, right) =>
      compare(left.id, right.id),
    ),
  }
}

export async function loadAuthenticatedExpectedInventory(
  stagingPath: string,
  descriptor: StagingDescriptor,
  manifest: RecoveryPointManifestV1,
): Promise<ExpectedInventory> {
  try {
    return await loadAuthenticatedExpectedInventoryUnchecked(stagingPath, descriptor, manifest)
  } catch (error) {
    if (error instanceof RecoveryPlanError) throw error
    throw new RecoveryPlanError(
      'integrity',
      'AUTHENTICATED_INVENTORY_INVALID',
      'A captured authenticated inventory is invalid or no longer matches verified staging',
    )
  }
}

async function pathState(path: string): Promise<'present' | 'missing' | 'unknown'> {
  try {
    await lstat(path)
    return 'present'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    return 'unknown'
  }
}

async function compareConfiguration(
  descriptor: StagingDescriptor,
  manifest: RecoveryPointManifestV1,
  inspectCurrentPath: (path: string) => Promise<'present' | 'missing' | 'unknown'>,
): Promise<{ items: ConfigComparisonItem[]; manual: ExpectedInventory['manual'] }> {
  const items = await Promise.all(
    manifest.sources
      .filter((source) => source.recoveryScope !== 'inventory')
      .map(async (source) => {
        const stagedEntryCount = descriptor.entries.filter(
          (entry) => entry.sourceId === source.id,
        ).length
        return {
          sourceId: source.id,
          plugin: source.plugin,
          name: source.name,
          declaredPath: source.declaredPath,
          currentState: await inspectCurrentPath(expandPath(source.declaredPath)),
          sourceStatus: source.status,
          recoveryState:
            source.status === 'captured' && stagedEntryCount > 0
              ? ('available' as const)
              : ('unavailable' as const),
          stagedEntryCount,
        }
      }),
  )
  items.sort((left, right) => compare(left.sourceId, right.sourceId))
  const manual: ExpectedInventory['manual'] = []
  for (const item of items) {
    if (item.recoveryState === 'unavailable') {
      manual.push({
        id: `config-source-${item.sourceId}-unavailable`,
        kind: 'manual',
        name: `${item.plugin}/${item.name}`,
        reason: `Configuration source is ${item.sourceStatus} in the authenticated recovery point and cannot be applied`,
      })
    }
    if (item.currentState === 'unknown') {
      manual.push({
        id: `config-current-${item.sourceId}-unknown`,
        kind: 'manual',
        name: `${item.plugin}/${item.name}`,
        reason:
          'Current configuration path could not be inspected safely; review it manually before apply',
      })
    }
  }
  return { items, manual }
}

function phases(
  software: RecoveryPlan['software'],
  actions: RecoveryPlan['allowlistedActions'],
  manual: RecoveryPlan['manualDependencies'],
  stagingIssues: RecoveryPlan['issues'],
): RecoveryPlanPhase[] {
  const installStatus = (phase: 'homebrew' | 'vscode'): RecoveryPlanPhase['status'] => {
    if (actions.some((action) => action.phase === phase)) return 'ready'
    const kinds =
      phase === 'homebrew'
        ? new Set(['homebrew-tap', 'homebrew-formula', 'homebrew-cask'])
        : new Set(['vscode-extension'])
    const missingManualSoftware = software.some(
      (item) => item.status === 'missing' && item.recovery === 'manual' && kinds.has(item.kind),
    )
    const missingInventoryOrCli = manual.some((item) => item.id.startsWith(`${phase}-`))
    return missingManualSoftware || missingInventoryOrCli ? 'manual' : 'completed'
  }
  return [
    {
      id: 'repository-authentication',
      status: 'completed',
      requiresExplicitConfirmation: false,
      description: 'Repository identity and protection mode authenticated',
    },
    {
      id: 'recovery-point-selection',
      status: 'completed',
      requiresExplicitConfirmation: false,
      description: 'An immutable healthy recovery point was fixed',
    },
    {
      id: 'inventory-comparison',
      status: 'completed',
      requiresExplicitConfirmation: false,
      description: 'Authenticated expected software was compared with this Mac',
    },
    {
      id: 'configuration-staging',
      status: 'completed',
      requiresExplicitConfirmation: false,
      description: 'Configuration was restored only into isolated staging',
    },
    {
      id: 'configuration-verification',
      status: stagingIssues.length > 0 ? 'manual' : 'completed',
      requiresExplicitConfirmation: false,
      description:
        stagingIssues.length > 0
          ? 'Content is authenticated, but staging fidelity issues require manual review'
          : 'Staged configuration content and metadata were verified',
    },
    {
      id: 'homebrew-install',
      status: installStatus('homebrew'),
      requiresExplicitConfirmation: true,
      description: 'Optional Homebrew install from a newly synthesized allowlisted Brewfile',
    },
    {
      id: 'vscode-install',
      status: installStatus('vscode'),
      requiresExplicitConfirmation: true,
      description: 'Optional exact VS Code extension installation',
    },
    {
      id: 'manual-dependencies',
      status: manual.length > 0 ? 'manual' : 'completed',
      requiresExplicitConfirmation: false,
      description:
        'Mac apps, Raycast, DMG, MAS, login, license, and unknown dependencies remain manual',
    },
    {
      id: 'configuration-apply',
      status: 'pending',
      requiresExplicitConfirmation: true,
      description:
        stagingIssues.length > 0
          ? 'Configuration apply is blocked until staging fidelity issues are reviewed and resolved'
          : 'Applying configuration to original paths is a separate reviewed recovery operation',
    },
    {
      id: 'post-apply-check',
      status: 'pending',
      requiresExplicitConfirmation: false,
      description: 'Verify restored applications and configuration after explicit apply',
    },
  ]
}

function fingerprint(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function recoveryPlanApprovalSnapshot(plan: RecoveryPlan): RecoveryPlanApprovalSnapshot {
  return {
    formatVersion: 1,
    repositoryId: plan.repository.id,
    protection: plan.repository.protection,
    pointId: plan.recoveryPoint.id,
    manifestFingerprint: plan.recoveryPoint.manifestFingerprint,
    selectionFingerprint: plan.staging.selectionFingerprint,
    stagingVerified: plan.staging.verified,
    stagingIssues: plan.issues,
    configuration: plan.configuration.items,
    software: plan.software,
    allowlistedActions: plan.allowlistedActions,
    manualDependencies: plan.manualDependencies,
    phases: plan.phases,
  }
}

async function generateRecoveryPlanUnchecked(
  options: RecoveryPlanOptions,
  dependencies: RecoveryPlanDependencies = {},
): Promise<RecoveryPlan> {
  assertSupportedRecoverySystem(options)
  const startedAt = safeNow(options.now)
  const staged = await stageRecovery({
    repositoryPath: options.repositoryPath,
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
    ...(options.pointId ? { pointId: options.pointId } : {}),
    stagingRoot: options.stagingRoot,
    selection: { kind: 'all' },
    rejectOriginalPathOverlap: true,
    ...(options.now ? { now: options.now } : {}),
  })
  if (
    staged.state === 'failure' ||
    (staged.category !== 'success' && staged.category !== 'partial')
  ) {
    assertCleanRecoveryStage(staged)
  }
  if (!staged.stagingPath || !staged.stagingId || !staged.pointId)
    throw new RecoveryPlanError(
      'integrity',
      'RECOVERY_STAGING_INCOMPLETE',
      'Recovery staging did not return a complete verified binding',
    )
  const authenticated = await authenticateStaging(
    {
      repositoryPath: options.repositoryPath,
      expectedRepositoryId: options.expectedRepositoryId,
      expectedProtection: options.expectedProtection,
      ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
    },
    staged.stagingPath,
  )
  const reproducibleFidelityIssues = authenticated.descriptor.entries.some(
    (entry) => entry.metadata.createdAtNs !== undefined,
  )
    ? [
        {
          code: 'CREATED_AT_MUTATION_UNSAFE',
          category: 'partial' as const,
          message: 'Creation timestamp has no proven object-bound restore operation',
          nextAction: 'Review fidelity before apply',
        },
      ]
    : []
  const stagingIssues = [
    ...staged.issues,
    ...authenticated.issues,
    ...reproducibleFidelityIssues,
  ].filter(
    (issue, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.code === issue.code &&
          candidate.category === issue.category &&
          candidate.message === issue.message,
      ) === index,
  )
  if (
    authenticated.manifest.health !== 'healthy' ||
    authenticated.manifest.verification !== 'content-readback' ||
    authenticated.descriptor.partialAccepted
  ) {
    throw new RecoveryPlanError(
      'integrity',
      'HEALTHY_RECOVERY_POINT_REQUIRED',
      'Recovery planning requires a healthy content-verified recovery point',
    )
  }
  const [expected, current, configurationComparison] = await Promise.all([
    loadAuthenticatedExpectedInventory(
      staged.stagingPath,
      authenticated.descriptor,
      authenticated.manifest,
    ),
    (dependencies.collectCurrentInventory ?? collectCurrentMachineInventory)(),
    compareConfiguration(
      authenticated.descriptor,
      authenticated.manifest,
      dependencies.inspectCurrentPath ?? pathState,
    ),
  ])
  const comparison = compareExpectedInventory(expected, current)
  const manualDependencies = [...comparison.manual, ...configurationComparison.manual].sort(
    (left, right) => compare(left.id, right.id),
  )
  const planPhases = phases(
    comparison.software,
    comparison.actions,
    manualDependencies,
    stagingIssues,
  )
  const fingerprintInput: RecoveryPlanApprovalSnapshot = {
    formatVersion: 1,
    repositoryId: authenticated.descriptor.repositoryId,
    protection: authenticated.descriptor.protection,
    pointId: authenticated.descriptor.pointId,
    manifestFingerprint: authenticated.descriptor.manifestFingerprint,
    selectionFingerprint: authenticated.descriptor.selectionFingerprint,
    stagingVerified: stagingIssues.length === 0,
    stagingIssues,
    configuration: configurationComparison.items,
    software: comparison.software,
    allowlistedActions: comparison.actions,
    manualDependencies,
    phases: planPhases,
  }
  const endedAt = safeNow(options.now)
  return {
    formatVersion: 1,
    operation: 'recovery-plan',
    state: stagingIssues.length > 0 ? 'partial' : 'success',
    category: stagingIssues.length > 0 ? 'partial' : 'success',
    dryRun: true,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    repository: {
      path: resolve(options.repositoryPath),
      id: authenticated.descriptor.repositoryId,
      protection: authenticated.descriptor.protection,
      authenticated: true,
    },
    recoveryPoint: {
      id: authenticated.descriptor.pointId,
      healthy: true,
      fixed: true,
      contentVerified: true,
      manifestFingerprint: authenticated.descriptor.manifestFingerprint,
    },
    staging: {
      id: authenticated.descriptor.stagingId,
      path: staged.stagingPath,
      verified: stagingIssues.length === 0,
      selectionFingerprint: authenticated.descriptor.selectionFingerprint,
    },
    configuration: {
      items: configurationComparison.items,
      stagedOnly: true,
      originalPathsChanged: false,
    },
    software: comparison.software,
    allowlistedActions: comparison.actions,
    manualDependencies,
    phases: planPhases,
    fingerprint: fingerprint(fingerprintInput),
    issues: stagingIssues,
    nextAction:
      stagingIssues.length > 0
        ? 'Review and resolve every staging fidelity issue before any configuration apply; application installs remain opt-in'
        : 'Review the staged configuration and missing applications; default recovery performs no installs and changes no original path',
  }
}

function sanitizedRecoveryPlanError(error: unknown): RecoveryPlanError {
  if (error instanceof RecoveryPlanError) return error
  if (error instanceof RecoveryFailure) {
    return new RecoveryPlanError(
      error.category,
      /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'RECOVERY_PLAN_FAILED',
      'Recovery staging or authentication did not complete safely',
    )
  }
  if (error instanceof RepositoryError) {
    return new RecoveryPlanError(
      error.category,
      /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'RECOVERY_REPOSITORY_FAILED',
      'The recovery repository could not be opened or verified safely',
    )
  }
  if (error instanceof ProtectionAuthenticationError) {
    return new RecoveryPlanError(
      'authentication',
      'RECOVERY_AUTHENTICATION_FAILED',
      'Recovery authentication failed',
    )
  }
  if (error instanceof ProtectionError) {
    return new RecoveryPlanError(
      'integrity',
      'RECOVERY_PROTECTION_FAILED',
      'Protected recovery data could not be authenticated safely',
    )
  }
  const code = error instanceof Error && 'code' in error ? String(error.code) : ''
  if (code === 'ENOENT') {
    return new RecoveryPlanError(
      'configuration',
      'RECOVERY_INPUT_MISSING',
      'A required recovery input is missing',
    )
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new RecoveryPlanError(
      'source',
      'RECOVERY_INPUT_UNREADABLE',
      'A required recovery input could not be read safely',
    )
  }
  return new RecoveryPlanError(
    'internal',
    'RECOVERY_PLAN_FAILED',
    'Recovery planning did not complete safely',
  )
}

export async function generateRecoveryPlan(
  options: RecoveryPlanOptions,
  dependencies: RecoveryPlanDependencies = {},
): Promise<RecoveryPlan> {
  try {
    return await generateRecoveryPlanUnchecked(options, dependencies)
  } catch (error) {
    throw sanitizedRecoveryPlanError(error)
  }
}

import type { CredentialProvider } from '../protection/credentials.js'
import type {
  ClassifiedIssue,
  OperationCategory,
  OperationState,
  ProtectionMode,
} from '../repository/index.js'

export type SoftwareKind =
  | 'homebrew-tap'
  | 'homebrew-formula'
  | 'homebrew-cask'
  | 'vscode-extension'
  | 'mac-app'
  | 'raycast-extension'
  | 'manual'

export type InstallPhase = 'homebrew' | 'vscode'

export interface RecoveryPlanRepositoryOptions {
  repositoryPath: string
  expectedRepositoryId: string
  expectedProtection: ProtectionMode
  credentialProvider?: CredentialProvider
}

export interface RecoveryPlanOptions extends RecoveryPlanRepositoryOptions {
  pointId?: string
  stagingRoot: string
  platform?: NodeJS.Platform
  architecture?: string
  now?: () => Date
}

export interface CurrentMachineInventory {
  homebrew: {
    available: boolean
    taps: string[]
    formulae: string[]
    casks: string[]
  }
  vscode: {
    available: boolean
    extensions: string[]
  }
  macApps: CurrentInventoryScan<{ name: string; bundleId: string | null; path: string }>
  raycastExtensions: CurrentInventoryScan<{ id: string; title: string | null }>
}

export interface CurrentInventoryScan<T> {
  items: T[]
  complete: boolean
  entriesVisited: number
  bytesRead: number
  maxDepthVisited: number
  issues: string[]
}

export interface ExpectedInventory {
  homebrew: {
    taps: string[]
    formulae: string[]
    casks: string[]
  }
  vscodeExtensions: string[]
  macApps: Array<{ name: string; bundleId: string | null; path: string }>
  raycastExtensions: Array<{ id: string; title: string | null }>
  manual: ManualDependency[]
}

export interface ManualDependency {
  id: string
  kind: SoftwareKind
  name: string
  reason: string
}

export interface SoftwareComparisonItem {
  id: string
  kind: SoftwareKind
  name: string
  status: 'installed' | 'missing' | 'unknown'
  recovery: 'allowlisted' | 'manual'
  reason?: string
}

export interface InstallerAction {
  id: string
  phase: InstallPhase
  kind: 'homebrew-tap' | 'homebrew-formula' | 'homebrew-cask' | 'vscode-extension'
  value: string
}

export interface ConfigComparisonItem {
  sourceId: string
  plugin: string
  name: string
  declaredPath: string
  currentState: 'present' | 'missing' | 'unknown'
  sourceStatus: 'captured' | 'missing' | 'failed' | 'unstable'
  recoveryState: 'available' | 'unavailable'
  stagedEntryCount: number
}

export interface RecoveryPlanPhase {
  id:
    | 'repository-authentication'
    | 'recovery-point-selection'
    | 'inventory-comparison'
    | 'configuration-staging'
    | 'configuration-verification'
    | 'homebrew-install'
    | 'vscode-install'
    | 'manual-dependencies'
    | 'configuration-apply'
    | 'post-apply-check'
  status: 'completed' | 'ready' | 'manual' | 'pending'
  requiresExplicitConfirmation: boolean
  description: string
}

export interface RecoveryPlan {
  formatVersion: 1
  operation: 'recovery-plan'
  state: OperationState
  category: OperationCategory
  dryRun: true
  startedAt: string
  endedAt: string
  repository: {
    path: string
    id: string
    protection: ProtectionMode
    authenticated: true
  }
  recoveryPoint: {
    id: string
    healthy: true
    fixed: true
    contentVerified: true
    manifestFingerprint: string
  }
  staging: {
    id: string
    path: string
    verified: boolean
    selectionFingerprint: string
  }
  configuration: {
    items: ConfigComparisonItem[]
    stagedOnly: true
    originalPathsChanged: false
  }
  software: SoftwareComparisonItem[]
  allowlistedActions: InstallerAction[]
  manualDependencies: ManualDependency[]
  phases: RecoveryPlanPhase[]
  fingerprint: string
  issues: ClassifiedIssue[]
  nextAction: string
}

export type InstallItemStatus =
  | 'pending'
  | 'succeeded'
  | 'already-present'
  | 'failed'
  | 'manual'
  | 'skipped'

export interface InstallJournalActionItem extends InstallerAction {
  status: Exclude<InstallItemStatus, 'manual'>
  issueCode?: string
}

export interface InstallJournalManualItem {
  id: string
  phase: 'manual'
  kind: SoftwareKind
  name: string
  reason: string
  status: 'manual'
}

export type InstallJournalItem = InstallJournalActionItem | InstallJournalManualItem

export interface RecoveryInstallCounts {
  total: number
  pending: number
  succeeded: number
  alreadyPresent: number
  failed: number
  manual: number
  skipped: number
}

export interface RecoveryInstallResult {
  operation: 'recovery-install'
  state: OperationState
  category: OperationCategory
  dryRun: boolean
  startedAt: string
  endedAt: string
  repositoryId: string
  pointId: string
  planFingerprint: string
  items: InstallJournalItem[]
  counts: RecoveryInstallCounts
  issues: ClassifiedIssue[]
  nextAction: string | null
}

export interface RecoveryPlanApprovalSnapshot {
  formatVersion: 1
  repositoryId: string
  protection: ProtectionMode
  pointId: string
  manifestFingerprint: string
  selectionFingerprint: string
  stagingVerified: boolean
  stagingIssues: ClassifiedIssue[]
  configuration: ConfigComparisonItem[]
  software: SoftwareComparisonItem[]
  allowlistedActions: InstallerAction[]
  manualDependencies: ManualDependency[]
  phases: RecoveryPlanPhase[]
}

export interface ExecuteRecoveryInstallOptions extends RecoveryPlanOptions {
  stateDirectory?: string
  phases: InstallPhase[]
  confirmedPhases?: InstallPhase[]
  execute?: boolean
  approvedPlanFingerprint?: string
  invocation?: 'interactive-cli' | 'daemon'
}

export class RecoveryPlanError extends Error {
  constructor(
    readonly category: Exclude<OperationCategory, 'success'>,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

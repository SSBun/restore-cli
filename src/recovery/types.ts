import type { CredentialProvider } from '../protection/credentials.js'
import type {
  ClassifiedIssue,
  OperationCategory,
  OperationState,
  ProtectionMode,
} from '../repository/index.js'
import type { ManifestEntryV1 } from '../verify/index.js'

export type RecoverySelection =
  | { kind: 'all' }
  | { kind: 'plugin'; plugin: string }
  | { kind: 'sources'; sourceIds: string[] }
  | { kind: 'paths'; paths: Array<{ sourceId: string; relativePath: string }> }

export interface RecoveryRepositoryOptions {
  repositoryPath: string
  expectedRepositoryId: string
  expectedProtection: ProtectionMode
  credentialProvider?: CredentialProvider
}

export interface ResolvePointOptions extends RecoveryRepositoryOptions {
  pointId?: string
  allowPartial?: boolean
  partialConsent?: 'I_ACCEPT_PARTIAL_RECOVERY'
}

export interface StageRecoveryOptions extends RecoveryRepositoryOptions {
  pointId?: string
  selection?: RecoverySelection
  stagingRoot: string
  allowPartial?: boolean
  partialConsent?: 'I_ACCEPT_PARTIAL_RECOVERY'
  rejectOriginalPathOverlap?: boolean
  now?: () => Date
  metadata?: MetadataOptions
  beforeEntryPublish?: (entry: ManifestEntryV1, destination: string) => void | Promise<void>
  beforeStagePublish?: (pendingPath: string, finalPath: string) => void | Promise<void>
}

export interface RecoverySourceSummary {
  id: string
  plugin: string
  name: string
  sensitivity: 'public' | 'private' | 'secret'
  declaredPath: string
  status: string
}

export interface RecoveryCounts {
  filesConsidered: number
  restored: number
  unchanged: number
  skipped: number
  conflicted: number
  failed: number
  fidelityLoss: number
  bytesRead: number
  bytesWritten: number
  bytesVerified: number
}

export interface RecoveryResult {
  operation: 'stage-recovery'
  state: OperationState
  category: OperationCategory
  startedAt: string
  endedAt: string
  repositoryId: string
  protection: ProtectionMode
  pointId: string | null
  stagingId: string | null
  stagingPath: string | null
  partialAccepted: boolean
  selection: RecoverySelection
  plugins: string[]
  sources: RecoverySourceSummary[]
  selectedPaths: string[]
  limitations: string[]
  counts: RecoveryCounts
  issues: ClassifiedIssue[]
  nextAction: string | null
}

export type ConflictPolicy = 'error' | 'overwrite' | 'skip'

export const APPLY_FIDELITY_CONSENT = 'I_ACCEPT_STAGING_FIDELITY_ISSUES' as const

export interface ApplyTargetMapping {
  sourceId: string
  targetPath: string
}

export interface ApplyOptions extends RecoveryRepositoryOptions {
  stagingPath: string
  targets: ApplyTargetMapping[]
  conflictPolicy?: ConflictPolicy
  dryRun?: boolean
  fidelityConsent?: string
  applyId?: string
  now?: () => Date
  metadata?: MetadataOptions
  beforeSafetyPublish?: () => void | Promise<void>
  afterSafetyManifestPublish?: () => void | Promise<void>
  afterSafetyPublish?: () => void | Promise<void>
  beforeTargetPublish?: (targetPath: string, entry: StagedEntry) => void | Promise<void>
  afterTargetPublish?: (targetPath: string, entry: StagedEntry) => void | Promise<void>
  directoryAcknowledgementMode?: 'normal' | 'suppress' | 'malformed' | 'crash-after-mutation'
}

export interface RecoveryDirectoryBinding {
  path: string
  device: string
  inode: string
}

export interface RollbackOptions extends RecoveryRepositoryOptions {
  stagingPath: string
  safetyId: string
  dryRun?: boolean
  deleteNewlyCreated?: boolean
  now?: () => Date
  metadata?: MetadataOptions
  beforeTargetPublish?: (targetPath: string) => void | Promise<void>
  afterTargetPublish?: (targetPath: string) => void | Promise<void>
}

export interface ApplyItemResult {
  entryId: string
  sourceId: string
  targetLabel: string
  status: 'applied' | 'unchanged' | 'skipped' | 'conflicted' | 'failed' | 'pending'
  issueCode?: string
}

export interface ApplyResult {
  operation: 'apply' | 'rollback'
  state: OperationState
  category: OperationCategory
  dryRun: boolean
  startedAt: string
  endedAt: string
  repositoryId: string
  protection: ProtectionMode
  pointId: string
  stagingId: string
  applyId: string
  safetyId: string | null
  conflictPolicy: ConflictPolicy
  planFingerprint: string
  counts: RecoveryCounts
  items: ApplyItemResult[]
  issues: ClassifiedIssue[]
  nextAction: string | null
}

export interface StagedEntry extends ManifestEntryV1 {
  stagingRelativePath: string
  selectionRole: 'selected' | 'dependency'
}

export interface StagingDescriptor {
  formatVersion: 1
  kind: 'restore-staging'
  stagingId: string
  repositoryId: string
  protection: ProtectionMode
  pointId: string
  pointCompletedAt: string
  manifestFingerprint: string
  selectionFingerprint: string
  selection: RecoverySelection
  partialAccepted: boolean
  createdAt: string
  status: 'verified'
  plugins: string[]
  sources: Array<{
    id: string
    plugin: string
    name: string
    sensitivity: 'public' | 'private' | 'secret'
    status: string
  }>
  entries: StagedEntry[]
}

export interface SafetyProtectionDescriptor {
  formatVersion: 1
  kind: 'restore-safety-protection'
  safetyId: string
  repositoryId: string
  pointId: string
  stagingId: string
  planFingerprint: string
  active: true
  createdAt: string
}

export interface MetadataIssue {
  code: string
  message: string
}

export type MetadataCommandRunner = (
  executable: string,
  args: string[],
) => Promise<{ stdout: Buffer; stderr?: Buffer }>

export interface MetadataOptions {
  commandRunner?: MetadataCommandRunner
  platform?: NodeJS.Platform
  onBeforeCommand?: (path: string) => void | Promise<void>
  onAfterCommand?: (path: string) => void | Promise<void>
  onNativeFdBound?: (path: string) => void | Promise<void>
}

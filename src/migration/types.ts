import type { CredentialProvider } from '../protection/credentials.js'
import type { OperationCategory, ProtectionMode } from '../repository/index.js'

export const LEGACY_FORMAT = 'restore-legacy-0.1.x' as const
export const LEGACY_MAX_FILE_BYTES = 64 * 1024 * 1024
export const LEGACY_MAX_CAPTURE_BYTES = 256 * 1024 * 1024
export const LEGACY_MAX_SOURCES = 256

export interface MigrationSystem {
  platform: NodeJS.Platform
  architecture: string
}

export interface LegacyIssue {
  code: string
  category: Exclude<OperationCategory, 'success'>
  message: string
  relativePath?: string
}

export interface LegacySourceIdentity {
  device: string
  inode: string
  changedAtNs: string
}

export interface LegacyEntryDescriptor {
  relativePath: string
  type: 'file' | 'directory'
  size: number
  mode: number
  modifiedAtNs: string
  contentHash?: string
}

export interface LegacyRecoveryPointDescriptor {
  id: string
  path: string
  createdAt: string
  digest: string
  identityDigest: string
  fileCount: number
  directoryCount: number
  totalBytes: number
  migratable: boolean
  entries: LegacyEntryDescriptor[]
  unsupported: LegacyIssue[]
}

export interface LegacyRepositoryDescriptor {
  format: typeof LEGACY_FORMAT
  compatibility: '0.1.x'
  rootPath: string
  marker: 'restore-backup-directory'
  readOnly: true
  identity: LegacySourceIdentity
  digest: string
  identityDigest: string
  points: LegacyRecoveryPointDescriptor[]
  unsupported: LegacyIssue[]
}

export interface LegacyRestoreFilePlan {
  sourcePath: string
  relativePath: string
  destinationPath: string
  bytes: number
  contentHash: string
}

export interface LegacyRestorePlan {
  operation: 'legacy-restore'
  dryRun: boolean
  source: {
    repositoryPath: string
    repositoryDigest: string
    repositoryIdentityDigest: string
    pointId: string
    pointDigest: string
    pointIdentityDigest: string
    readOnly: true
  }
  destination: {
    path: string
    device: string
    inode: string
    overwrite: false
    deletes: false
    atomicFiles: true
  }
  planDigest: string
  files: LegacyRestoreFilePlan[]
  totalBytes: number
  limitations: string[]
}

export interface LegacyRestoreResult extends LegacyRestorePlan {
  startedAt: string
  endedAt: string
  state: 'success' | 'failure'
  category: OperationCategory
  counts: {
    filesConsidered: number
    filesWritten: number
    filesSkipped: number
    filesFailed: number
    bytesRead: number
    bytesWritten: number
  }
  verificationScope: 'structural' | 'content'
  filesRestored: number
  bytesRestored: number
  issues: LegacyIssue[]
}

export interface LegacyRestoreOptions {
  legacyRepositoryPath: string
  pointId: string
  destinationPath: string
  /** Original absolute legacy paths to select. Omit to select the full point. */
  originalPaths?: string[]
  /** Restore is a dry-run unless this is exactly false. */
  dryRun?: boolean
  /** Required for execution and must equal the immediately reproducible dry-run plan digest. */
  approvedPlanDigest?: string
  system?: MigrationSystem
}

export interface LegacyMigrationSource {
  id: string
  declaredPath: string
  legacyPath: string
  expectedType: 'file' | 'directory'
  fileCount: number
  totalBytes: number
}

export interface LegacyMigrationExpectedEntry {
  sourceId: string
  relativePath: string
  type: 'file' | 'directory'
  size: number
  mode: number
  modifiedAtNs: string
  contentHash?: string
}

export interface LegacyMigrationPointPlan {
  legacyPointId: string
  legacyPointDigest: string
  targetPointId: string
  createdAt: string
  fileCount: number
  totalBytes: number
  sources: LegacyMigrationSource[]
  entries: LegacyMigrationExpectedEntry[]
  status: 'migratable' | 'unsupported'
  unsupported: LegacyIssue[]
}

export interface MigrationTargetReport {
  repositoryPath: string
  repositoryId: string
  protection: ProtectionMode
  requiredBytes: string
  availableBytes: string | null
  authenticated: boolean
  capabilityChecked: boolean
  lockChecked: boolean
}

export interface LegacyMigrationPointResult {
  legacyPointId: string
  targetPointId: string
  state: 'planned' | 'imported' | 'already-imported' | 'unsupported' | 'failure'
  contentVerified: boolean
  issues: LegacyIssue[]
}

export interface LegacyMigrationReport {
  operation: 'legacy-migrate'
  startedAt: string
  endedAt: string
  dryRun: boolean
  state: 'success' | 'partial' | 'failure'
  category: OperationCategory
  counts: {
    filesConsidered: number
    filesWritten: number
    filesSkipped: number
    filesFailed: number
    bytesRead: number
    bytesWritten: number
  }
  verificationScope: 'structural' | 'content'
  source: {
    repositoryPath: string
    repositoryDigest: string
    readOnly: true
    deleted: false
  }
  target: MigrationTargetReport
  points: LegacyMigrationPointPlan[]
  results: LegacyMigrationPointResult[]
  unsupported: LegacyIssue[]
  finalRepositoryVerified: boolean
  limitations: string[]
}

export interface LegacyMigrationOptions {
  legacyRepositoryPath: string
  repositoryPath: string
  expectedRepositoryId: string
  expectedProtection: ProtectionMode
  credentialProvider?: CredentialProvider
  /** Legacy point IDs. Omit to migrate every complete 0.1.x point. */
  pointIds?: string[]
  /** Migration is a dry-run unless this is exactly false. */
  dryRun?: boolean
  cliVersion?: string
  system?: MigrationSystem
}

export class LegacyMigrationError extends Error {
  readonly code: string
  readonly category: LegacyIssue['category']

  constructor(code: string, category: LegacyIssue['category'], message: string) {
    super(message)
    this.name = 'LegacyMigrationError'
    this.code = code
    this.category = category
  }
}

import type { CredentialProvider } from '../protection/credentials.js'
import type {
  ClassifiedIssue,
  OperationCategory,
  OperationState,
  ProtectionMode,
  RepositoryHandle,
} from '../repository/index.js'

export const POINT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/
export const MAX_POINT_DESCRIPTOR_BYTES = 64 * 1024
export const MAX_PROTECTED_MANIFEST_BYTES = 16 * 1024 * 1024
export const MAX_PROTECTED_BLOB_BYTES = 64 * 1024 * 1024 + 1024

export type VerificationScope = 'structural' | 'content'
export type PointHealth = 'healthy' | 'partial' | 'failed'

export interface PointDescriptorV1 {
  formatVersion: 1
  pointId: string
  startedAt: string
  completedAt: string
  protection: ProtectionMode
  publication: 'verified'
  manifest: 'manifest.enc' | 'manifest.json'
}

export interface ManifestBlobV1 {
  id: string
  entryId: string
  path: string
  contentHash: string
  plaintextBytes: number
  protectedBytes: number
}

export interface ManifestEntryV1 {
  id: string
  sourceId: string
  relativePath: string
  type: 'file' | 'directory' | 'symlink'
  metadata: {
    mode: number
    size: number
    modifiedAtNs: string
    createdAtNs?: string
    xattrs?: Array<{ name: string; value: string }>
    flags?: string[]
  }
  fidelityIssues?: Array<{
    code: 'METADATA_XATTR_UNREADABLE' | 'METADATA_FLAGS_UNREADABLE'
    message: string
  }>
  linkTarget?: string
  hardlinkTo?: string
  contentHash?: string
  blobId?: string
}

export interface ManifestSourceV1 {
  id: string
  plugin: string
  name: string
  declaredPath: string
  resolvedPath: string
  requirement: 'required' | 'optional'
  sensitivity: 'public' | 'private' | 'secret'
  expectedType: 'file' | 'directory' | 'symlink' | 'any'
  recoveryScope: string
  consistencyGroup?: string
  includeEmptyDirectories: boolean
  status: 'captured' | 'missing' | 'failed' | 'unstable'
  entryIds: string[]
}

export interface RecoveryPointManifestV1 {
  formatVersion: 1
  pointId: string
  startedAt: string
  completedAt: string
  sourceHost: {
    hostname: string
    platform: string
    osRelease: string
    architecture: string
  }
  cliVersion: string
  repositoryId: string
  protection: ProtectionMode
  health: 'healthy' | 'partial'
  verification: 'content-readback'
  plugins: string[]
  sources: ManifestSourceV1[]
  entries: ManifestEntryV1[]
  blobs: ManifestBlobV1[]
  warnings: Array<{
    code: string
    sourceId: string
    message: string
    severity: 'warning' | 'partial' | 'failure'
  }>
  consistencyGroupsFailed: string[]
  plaintextSecretAcceptances: Array<{
    repositoryId: string
    sourceId: string
    sourceContractFingerprint: string
    acceptedAt: string
  }>
}

export interface DiscoveredPoint {
  id: string
  path: string
  descriptor: PointDescriptorV1
  device: bigint
  inode: bigint
}

export interface PointDiscoveryDiagnostic {
  pointId: string | null
  name: string
  code: string
  category: 'integrity'
  message: string
}

export interface PointDiscoveryResult {
  points: DiscoveredPoint[]
  diagnostics: PointDiscoveryDiagnostic[]
  ignoredResidue: number
}

export type VerificationSelector =
  | { kind: 'point'; pointId: string }
  | { kind: 'latest' }
  | { kind: 'latest-healthy' }
  | { kind: 'all' }

export interface VerificationCoverage {
  pointsConsidered: number
  pointsVerified: number
  pointsSkipped: number
  pointsFailed: number
  filesConsidered: number
  filesVerified: number
  filesSkipped: number
  filesFailed: number
  bytesConsidered: number
  bytesVerified: number
  bytesSkipped: number
  bytesFailed: number
  complete: boolean
}

export interface PointVerificationResult {
  pointId: string
  completedAt: string | null
  manifestHealth: 'healthy' | 'partial' | null
  state: OperationState
  category: OperationCategory
  structurallyHealthy: boolean
  contentHealthy: boolean | null
  filesConsidered: number
  filesVerified: number
  filesSkipped: number
  filesFailed: number
  bytesConsidered: number
  bytesVerified: number
  bytesSkipped: number
  bytesFailed: number
  issues: ClassifiedIssue[]
}

export interface VerificationReport extends VerificationCoverage {
  operation: 'verify'
  scope: VerificationScope
  verificationScope: VerificationScope
  selector: VerificationSelector
  resolvedPointIds: string[]
  resolvedPointId: string | null
  repositoryId: string
  protection: ProtectionMode
  startedAt: string
  endedAt: string
  durationMs: number
  cost: 'low' | 'high'
  state: OperationState
  category: OperationCategory
  coverage: VerificationCoverage
  points: PointVerificationResult[]
  issues: ClassifiedIssue[]
  nextAction: string | null
}

export interface VerifyV1Options {
  repositoryPath: string
  expectedRepositoryId: string
  expectedProtection: ProtectionMode
  credentialProvider?: CredentialProvider
  selector: VerificationSelector
  scope: VerificationScope
  now?: () => Date
  openRepository?: (
    path: string,
    options: {
      intent: 'read'
      expectedRepositoryId: string
      expectedProtection: ProtectionMode
      credentialProvider?: CredentialProvider
    },
  ) => Promise<RepositoryHandle>
}

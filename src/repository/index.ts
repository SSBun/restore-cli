export { RepositoryError } from './errors.js'
export {
  revokeDailyCredential,
  rotateRecoveryCredential,
} from './credentials.js'
export type {
  CredentialLifecycleDependencies,
  DailyCredentialRevocationResult,
  DailyCredentialRevocationFailureEvidence,
  LockCleanupResult,
  RecoveryCredentialRotationResult,
} from './credentials.js'
export { getRepositoryLayout, getRepositoryPath } from './layout.js'
export {
  acquireRepositoryLock,
  assertRepositoryLockOwnership,
  clearConfirmedRepositoryLock,
  clearOrphanedRepositoryLock,
  clearStaleRepositoryLock,
  inspectRepositoryLock,
  RepositoryLockError,
} from './lock.js'
export type {
  ConfirmedRepositoryLockClearOptions,
  RepositoryLock,
  RepositoryLockInspection,
  RepositoryLockMetadata,
} from './lock.js'
export {
  createOperationResult,
  listOperationResults,
  MAX_OPERATION_HISTORY_ENTRIES,
  MAX_OPERATION_PENDING_ENTRIES,
  recordOperationResult,
} from './operations.js'
export type {
  ClassifiedIssue,
  CreateOperationResultInput,
  OperationCategory,
  OperationCounts,
  OperationResult,
  OperationState,
  VerificationScope,
} from './operations.js'
export {
  initializeRepository,
  openRepository,
  parseRepositoryDescriptor,
} from './repository.js'
export type {
  InitializeRepositoryOptions,
  OpenRepositoryOptions,
  RecoveryCredentialExporter,
} from './repository.js'
export {
  createMacOsStableIdentityResolver,
  preflightTarget,
  readTargetIdentity,
  targetIdentityMatches,
} from './target.js'
export type {
  BoundedNativeCommandRunner,
  PreflightTargetOptions,
  StableIdentityContext,
  StableTargetIdentityResolver,
} from './target.js'
export {
  REPOSITORY_DIRECTORY_NAME,
  REPOSITORY_FORMAT_VERSION,
} from './types.js'
export type {
  ProtectionMode,
  RepositoryDescriptor,
  RepositoryHandle,
  RepositoryInitResult,
  RepositoryIntent,
  RepositoryLayout,
  TargetCapabilities,
  TargetIdentity,
  TargetPreflight,
} from './types.js'

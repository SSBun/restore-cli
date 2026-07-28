export { applyStaging, rollbackSafetyPoint } from './apply.js'
export { APPLY_FIDELITY_CONSENT } from './types.js'
export {
  captureCurrentMetadata,
  restoreMetadata,
  verifyMetadata,
} from './metadata.js'
export {
  assertSafetyPointExpectations,
  createSafetyPoint,
  deactivateSafetyProtection,
  isRecoveryPointProtectedBySafety,
  readSafetyBlob,
  readSafetyPoint,
} from './safety.js'
export type {
  SafetyCaptureItem,
  SafetyEntry,
  SafetyManifest,
} from './safety.js'
export {
  resolvePoint,
  authenticateStaging,
  browseRecoveryPoints,
  readStagingDescriptor,
  stageRecovery,
  verifyStaging,
  RecoveryFailure,
} from './stage.js'
export type {
  ApplyItemResult,
  ApplyOptions,
  ApplyResult,
  ApplyTargetMapping,
  ConflictPolicy,
  MetadataCommandRunner,
  MetadataIssue,
  MetadataOptions,
  RecoveryCounts,
  RecoveryRepositoryOptions,
  ResolvePointOptions,
  RecoveryResult,
  RecoverySelection,
  RecoverySourceSummary,
  RollbackOptions,
  SafetyProtectionDescriptor,
  StageRecoveryOptions,
  StagedEntry,
  StagingDescriptor,
} from './types.js'

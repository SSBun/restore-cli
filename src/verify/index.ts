export { discoverVisiblePoints, sortPointsNewestFirst } from './discovery.js'
export type {
  DiscoveredPoint,
  ManifestBlobV1,
  ManifestEntryV1,
  ManifestSourceV1,
  PointDescriptorV1,
  PointDiscoveryDiagnostic,
  PointDiscoveryResult,
  PointHealth,
  PointVerificationResult,
  RecoveryPointManifestV1,
  VerificationCoverage,
  VerificationReport,
  VerificationScope,
  VerificationSelector,
  VerifyV1Options,
} from './types.js'
export {
  MAX_POINT_DESCRIPTOR_BYTES,
  MAX_PROTECTED_BLOB_BYTES,
  MAX_PROTECTED_MANIFEST_BYTES,
  POINT_ID_PATTERN,
} from './types.js'
export {
  assertDescriptorManifestAgreement,
  parsePointDescriptorV1,
  parseRecoveryPointManifestV1,
  V1ValidationError,
} from './validation.js'
export { verifyV1Repository } from './verify.js'

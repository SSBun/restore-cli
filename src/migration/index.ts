export {
  assertLegacySourceUnchanged,
  assertMigrationSystem,
  detectLegacyRepository,
  isLegacyRepository,
  listLegacyRecoveryPoints,
  readLegacyRepository,
} from './legacy.js'
export type { LegacyReadOptions } from './legacy.js'
export {
  buildLegacyMigrationPointPlan,
  migrateLegacyRepository,
} from './migrate.js'
export type { LegacyMigrationDependencies } from './migrate.js'
export { planLegacyRestore, restoreLegacyRecoveryPoint } from './restore.js'
export type { LegacyRestoreDependencies } from './restore.js'
export {
  LEGACY_FORMAT,
  LEGACY_MAX_CAPTURE_BYTES,
  LEGACY_MAX_FILE_BYTES,
  LEGACY_MAX_SOURCES,
  LegacyMigrationError,
} from './types.js'
export type {
  LegacyEntryDescriptor,
  LegacyIssue,
  LegacyMigrationOptions,
  LegacyMigrationExpectedEntry,
  LegacyMigrationPointPlan,
  LegacyMigrationPointResult,
  LegacyMigrationReport,
  LegacyMigrationSource,
  LegacyRecoveryPointDescriptor,
  LegacyRepositoryDescriptor,
  LegacyRestoreFilePlan,
  LegacyRestoreOptions,
  LegacyRestorePlan,
  LegacyRestoreResult,
  LegacySourceIdentity,
  MigrationSystem,
  MigrationTargetReport,
} from './types.js'

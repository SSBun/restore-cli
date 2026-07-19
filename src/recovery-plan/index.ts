export {
  compareExpectedInventory,
  parseAllowlistedBrewfile,
  parseAllowlistedVSCodeInventory,
  parseMacAppsInventory,
  parseRaycastInventory,
  synthesizeBrewfile,
} from './inventory.js'
export {
  HOMEBREW_EXECUTABLE,
  VSCODE_EXECUTABLE_CANDIDATES,
  collectCurrentMachineInventory,
  runReadOnlyCommand,
  scanBoundedMacApplications,
  scanBoundedRaycastExtensions,
} from './current.js'
export {
  assertSupportedRecoverySystem,
  generateRecoveryPlan,
  recoveryPlanApprovalSnapshot,
} from './plan.js'
export {
  executeRecoveryInstallPlan,
  MAX_INSTALL_JOURNAL_BYTES,
  MAX_INSTALL_JOURNAL_ITEMS,
  recoveryInstallJournalBasename,
  recoveryInstallLeaseBasename,
  runInstallerCommand,
} from './execute.js'
export type {
  CurrentInventoryScanLimits,
  CurrentInventoryScanOptions,
  ReadOnlyCommandRunner,
} from './current.js'
export type { RecoveryPlanDependencies } from './plan.js'
export type {
  InstallerCommandRunner,
  InstallerCommandTestHooks,
  RecoveryInstallDependencies,
} from './execute.js'
export type { ParsedBrewfile, ParsedVSCodeInventory } from './inventory.js'
export type {
  ConfigComparisonItem,
  CurrentMachineInventory,
  CurrentInventoryScan,
  ExecuteRecoveryInstallOptions,
  ExpectedInventory,
  InstallerAction,
  InstallItemStatus,
  InstallJournalItem,
  InstallPhase,
  ManualDependency,
  RecoveryInstallResult,
  RecoveryPlan,
  RecoveryPlanApprovalSnapshot,
  RecoveryPlanOptions,
  RecoveryPlanPhase,
  RecoveryPlanRepositoryOptions,
  SoftwareComparisonItem,
  SoftwareKind,
} from './types.js'
export { RecoveryPlanError } from './types.js'

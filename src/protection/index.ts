export type { CredentialProvider } from './credentials.js'
export {
  createEncryptedProtector,
  createPlaintextProtector,
  generateMasterKey,
} from './crypto.js'
export type {
  ContentProtector,
  ProtectedContentPurpose,
  ProtectionContext,
} from './crypto.js'
export {
  ProtectionAuthenticationError,
  ProtectionError,
} from './errors.js'
export {
  MacOsKeychainCredentialProvider,
  SECURITY_EXECUTABLE,
  runSecurityCommand,
} from './keychain.js'
export type { SecurityCommandRunner } from './keychain.js'
export {
  exportRecoverySecret,
  generateRecoverySecret,
  importRecoverySecret,
  parseWrappedMasterKey,
  unwrapMasterKey,
  wrapMasterKey,
} from './recovery.js'
export type { WrappedMasterKey } from './recovery.js'
export { MasterKey, RecoverySecret } from './secrets.js'
export {
  authenticateMasterKey,
  unlockWithCredentialProvider,
  unlockWithRecoveryCredential,
} from './unlock.js'

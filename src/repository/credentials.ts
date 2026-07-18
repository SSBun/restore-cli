import type { CredentialProvider } from '../protection/credentials.js'
import {
  exportRecoverySecret,
  generateRecoverySecret,
  importRecoverySecret,
  unwrapMasterKey,
  wrapMasterKey,
} from '../protection/recovery.js'
import type { MasterKey, RecoverySecret } from '../protection/secrets.js'
import { authenticateMasterKey } from '../protection/unlock.js'
import { assertRepositoryWriteAuthorized, closeRepositoryWrite } from './authorization.js'
import { RepositoryError } from './errors.js'
import { readBoundedRegularFile, replaceDurableFile } from './io.js'
import { type RepositoryLock, acquireRepositoryLock } from './lock.js'
import { type RecoveryCredentialExporter, verifyExportedRecoveryMaterial } from './repository.js'
import type { RepositoryHandle } from './types.js'

export interface RecoveryCredentialRotationResult {
  repositoryId: string
  rotatedAt: string
  committed: true
  currentWrapperReplaced: true
  commitDurability: { status: 'synced' } | { status: 'failed'; code: 'DIRECTORY_SYNC_FAILED' }
  lockCleanup: LockCleanupResult
}

export interface DailyCredentialRevocationResult {
  repositoryId: string
  credentialDeleted: true
  repositoryClosed: true
  lockCleanup: LockCleanupResult
}

export interface DailyCredentialRevocationFailureEvidence {
  credentialDeletion: 'deleted' | 'unknown'
  repositoryClosed: true
  lockCleanup: LockCleanupResult
}

export type LockCleanupResult =
  | { status: 'released' }
  | { status: 'failed'; category: 'lock'; code: string }

type RepositoryLockAcquirer = typeof acquireRepositoryLock

export interface CredentialLifecycleDependencies {
  acquireLock?: RepositoryLockAcquirer
  replaceDurableFile?: typeof replaceDurableFile
}

function safeLockCleanupFailure(error: unknown): Extract<LockCleanupResult, { status: 'failed' }> {
  const code =
    error instanceof RepositoryError &&
    error.category === 'lock' &&
    /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)
      ? error.code
      : 'LOCK_RELEASE_FAILED'
  return { status: 'failed', category: 'lock', code }
}

async function releaseLifecycleLock(lock: RepositoryLock): Promise<LockCleanupResult> {
  try {
    await lock.release()
    return { status: 'released' }
  } catch (error) {
    return safeLockCleanupFailure(error)
  }
}

function attachLockCleanupEvidence(primary: unknown, cleanup: LockCleanupResult): unknown {
  if (cleanup.status === 'released') return primary
  if (
    (typeof primary === 'object' || typeof primary === 'function') &&
    primary !== null &&
    Object.isExtensible(primary)
  ) {
    Object.defineProperty(primary, 'lockCleanup', {
      configurable: true,
      enumerable: true,
      value: cleanup,
    })
    return primary
  }
  const failure = new RepositoryError(
    'integrity',
    'CREDENTIAL_LIFECYCLE_FAILED',
    'Credential lifecycle operation failed and the repository lock could not be released',
  )
  Object.defineProperty(failure, 'lockCleanup', { enumerable: true, value: cleanup })
  return failure
}

function attachRevocationFailureEvidence(
  primary: unknown,
  evidence: DailyCredentialRevocationFailureEvidence,
): unknown {
  let failure = primary
  if (
    !(
      (typeof failure === 'object' || typeof failure === 'function') &&
      failure !== null &&
      Object.isExtensible(failure)
    )
  ) {
    failure = new RepositoryError(
      'integrity',
      'CREDENTIAL_LIFECYCLE_FAILED',
      'Daily credential revocation did not complete cleanly',
    )
  }
  for (const [key, value] of Object.entries(evidence)) {
    Object.defineProperty(failure, key, { configurable: true, enumerable: true, value })
  }
  return failure
}

/**
 * Rewraps the unchanged master key. This revokes the old secret only against the current
 * recovery.json; a copied old wrapper plus its old secret necessarily remains usable.
 */
export async function rotateRecoveryCredential(
  repository: RepositoryHandle,
  credentialProvider: CredentialProvider,
  exportRecoveryCredential: RecoveryCredentialExporter,
  now = new Date(),
  dependencies: CredentialLifecycleDependencies = {},
): Promise<RecoveryCredentialRotationResult> {
  assertRepositoryWriteAuthorized(repository)
  if (repository.descriptor.protection !== 'encrypted') {
    throw new RepositoryError(
      'configuration',
      'ENCRYPTED_REPOSITORY_REQUIRED',
      'Recovery credential rotation requires an encrypted repository',
    )
  }
  if (!Number.isFinite(now.getTime())) {
    throw new RepositoryError('configuration', 'INVALID_TIME', 'Rotation time is invalid')
  }

  const lock = await (dependencies.acquireLock ?? acquireRepositoryLock)(
    repository,
    'recovery-credential-rotate',
  )
  let masterKey: MasterKey | undefined
  let recoverySecret: RecoverySecret | undefined
  let importedSecret: ReturnType<typeof importRecoverySecret> | undefined
  let unwrappedMasterKey: Awaited<ReturnType<typeof unwrapMasterKey>> | undefined
  let committed = false
  let commitDurability: RecoveryCredentialRotationResult['commitDurability'] | undefined
  let primaryError: unknown

  try {
    masterKey = await credentialProvider.loadMasterKey(repository.descriptor.repositoryId)
    recoverySecret = generateRecoverySecret()
    const keyCheck = await readBoundedRegularFile(repository.layout.keyCheck, 4 * 1024)
    const protector = await authenticateMasterKey(
      repository.descriptor.repositoryId,
      masterKey,
      keyCheck,
    )
    protector.dispose()

    const wrapped = await wrapMasterKey(
      repository.descriptor.repositoryId,
      masterKey,
      recoverySecret,
    )
    const persistedMaterial = verifyExportedRecoveryMaterial(
      await exportRecoveryCredential(exportRecoverySecret(recoverySecret)),
    )
    importedSecret = importRecoverySecret(persistedMaterial)
    unwrappedMasterKey = await unwrapMasterKey(
      repository.descriptor.repositoryId,
      wrapped,
      importedSecret,
    )
    if (!masterKey.equals(unwrappedMasterKey)) {
      throw new RepositoryError(
        'authentication',
        'RECOVERY_EXPORT_NOT_VERIFIED',
        'Persisted recovery credential did not unlock the master key',
      )
    }

    const replacement = await (dependencies.replaceDurableFile ?? replaceDurableFile)(
      repository.layout.recoveryKey,
      `${JSON.stringify(wrapped, null, 2)}\n`,
    )
    committed = replacement.committed
    commitDurability = replacement.directorySync
  } catch (error) {
    primaryError = error
  } finally {
    masterKey?.dispose()
    recoverySecret?.dispose()
    importedSecret?.dispose()
    unwrappedMasterKey?.dispose()
  }

  const lockCleanup = await releaseLifecycleLock(lock)
  if (committed && commitDurability) {
    return {
      repositoryId: repository.descriptor.repositoryId,
      rotatedAt: now.toISOString(),
      committed: true,
      currentWrapperReplaced: true,
      commitDurability,
      lockCleanup,
    }
  }
  throw attachLockCleanupEvidence(primaryError, lockCleanup)
}

export async function revokeDailyCredential(
  repository: RepositoryHandle,
  credentialProvider: CredentialProvider,
  dependencies: CredentialLifecycleDependencies = {},
): Promise<DailyCredentialRevocationResult> {
  assertRepositoryWriteAuthorized(repository)
  if (repository.descriptor.protection !== 'encrypted') {
    throw new RepositoryError(
      'configuration',
      'ENCRYPTED_REPOSITORY_REQUIRED',
      'Daily credential revocation requires an encrypted repository',
    )
  }
  const lock = await (dependencies.acquireLock ?? acquireRepositoryLock)(
    repository,
    'daily-credential-revoke',
  )
  let credentialDeleted = false
  let primaryError: unknown
  try {
    await credentialProvider.deleteMasterKey(repository.descriptor.repositoryId)
    credentialDeleted = true
  } catch (error) {
    primaryError = error
  } finally {
    closeRepositoryWrite(repository)
    try {
      repository.close()
    } catch (error) {
      primaryError ??= error
    }
  }

  const lockCleanup = await releaseLifecycleLock(lock)
  if (credentialDeleted && primaryError === undefined) {
    return {
      repositoryId: repository.descriptor.repositoryId,
      credentialDeleted: true,
      repositoryClosed: true,
      lockCleanup,
    }
  }
  throw attachRevocationFailureEvidence(primaryError, {
    credentialDeletion: credentialDeleted ? 'deleted' : 'unknown',
    repositoryClosed: true,
    lockCleanup,
  })
}

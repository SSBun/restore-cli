import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { CredentialProvider } from '../protection/credentials.js'
import {
  type ContentProtector,
  createEncryptedProtector,
  createPlaintextProtector,
  generateMasterKey,
} from '../protection/crypto.js'
import { ProtectionAuthenticationError, ProtectionError } from '../protection/errors.js'
import {
  exportRecoverySecret,
  generateRecoverySecret,
  importRecoverySecret,
  parseWrappedMasterKey,
  unwrapMasterKey,
  wrapMasterKey,
} from '../protection/recovery.js'
import { unlockWithCredentialProvider } from '../protection/unlock.js'
import { authorizeRepositoryWrite, closeRepositoryWrite } from './authorization.js'
import { RepositoryError, isNodeError } from './errors.js'
import {
  SafeFileError,
  readBoundedRegularFile,
  syncDirectory,
  writeDurableExclusiveFile,
} from './io.js'
import { getRepositoryLayout, getRepositoryPath } from './layout.js'
import {
  type StableTargetIdentityResolver,
  preflightTarget,
  targetIdentityMatches,
} from './target.js'
import {
  type ProtectionMode,
  REPOSITORY_DIRECTORY_NAME,
  REPOSITORY_FORMAT_VERSION,
  type RepositoryDescriptor,
  type RepositoryHandle,
  type RepositoryInitResult,
  type RepositoryIntent,
  type TargetIdentity,
} from './types.js'

const MAX_DESCRIPTOR_BYTES = 64 * 1024
const MAX_RECOVERY_KEY_BYTES = 64 * 1024
const MAX_KEY_CHECK_BYTES = 4 * 1024
const MAX_RECOVERY_MATERIAL_BYTES = 1024

export type RecoveryCredentialExporter = (material: string) => Promise<string | Uint8Array>

export interface InitializeRepositoryOptions {
  targetPath: string
  protection?: ProtectionMode
  requiredBytes?: bigint
  credentialProvider?: CredentialProvider
  exportRecoveryCredential?: RecoveryCredentialExporter
  stableIdentityResolver?: StableTargetIdentityResolver
  now?: () => Date
}

export interface OpenRepositoryOptions {
  intent: RepositoryIntent
  expectedRepositoryId: string
  expectedProtection: ProtectionMode
  credentialProvider?: CredentialProvider
  requiredBytes?: bigint
  stableIdentityResolver?: StableTargetIdentityResolver
}

interface ValidatedProtectionFiles {
  keyCheck?: Buffer
}

function isTargetIdentity(value: unknown): value is TargetIdentity {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TargetIdentity>
  return (
    typeof candidate.deviceId === 'string' &&
    typeof candidate.fileSystemType === 'string' &&
    typeof candidate.mountPath === 'string' &&
    typeof candidate.stableIdentity === 'string' &&
    candidate.deviceId.length > 0 &&
    candidate.fileSystemType.length > 0 &&
    /^(?:volume:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|network-sha256:[0-9a-f]{64})$/.test(
      candidate.stableIdentity,
    ) &&
    isAbsolute(candidate.mountPath)
  )
}

export function parseRepositoryDescriptor(value: unknown): RepositoryDescriptor {
  if (!value || typeof value !== 'object') {
    throw new RepositoryError('integrity', 'INVALID_DESCRIPTOR', 'Repository descriptor is invalid')
  }

  const candidate = value as Partial<RepositoryDescriptor>
  if (candidate.formatVersion !== REPOSITORY_FORMAT_VERSION) {
    throw new RepositoryError(
      'destination',
      'UNSUPPORTED_REPOSITORY_FORMAT',
      'Repository format is not supported by this version of Restore',
    )
  }
  if (
    typeof candidate.repositoryId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate.repositoryId,
    ) ||
    typeof candidate.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    (candidate.protection !== 'encrypted' && candidate.protection !== 'plaintext') ||
    !isTargetIdentity(candidate.targetIdentity)
  ) {
    throw new RepositoryError('integrity', 'INVALID_DESCRIPTOR', 'Repository descriptor is invalid')
  }

  return candidate as RepositoryDescriptor
}

async function readDescriptor(path: string): Promise<RepositoryDescriptor> {
  try {
    const content = await readBoundedRegularFile(path, MAX_DESCRIPTOR_BYTES)
    return parseRepositoryDescriptor(JSON.parse(content.toString('utf8')))
  } catch (error) {
    if (error instanceof RepositoryError) throw error
    if (error instanceof SafeFileError) {
      throw new RepositoryError(
        'integrity',
        'INVALID_DESCRIPTOR',
        'Repository descriptor is missing or unsafe',
      )
    }
    throw new RepositoryError('integrity', 'INVALID_DESCRIPTOR', 'Repository descriptor is invalid')
  }
}

async function requireDirectory(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isDirectory()) return
  } catch {}
  throw new RepositoryError('integrity', 'INVALID_LAYOUT', 'Repository layout is incomplete')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

async function validateLayout(
  handle: Pick<RepositoryHandle, 'descriptor' | 'layout'>,
): Promise<ValidatedProtectionFiles> {
  await Promise.all([
    requireDirectory(handle.layout.keys),
    requireDirectory(handle.layout.points),
    requireDirectory(handle.layout.locks),
    requireDirectory(handle.layout.operations),
  ])

  const hasRecoveryKey = await pathExists(handle.layout.recoveryKey)
  const hasKeyCheck = await pathExists(handle.layout.keyCheck)
  if (
    (handle.descriptor.protection === 'encrypted' && (!hasRecoveryKey || !hasKeyCheck)) ||
    (handle.descriptor.protection === 'plaintext' && (hasRecoveryKey || hasKeyCheck))
  ) {
    throw new RepositoryError(
      'integrity',
      'INVALID_PROTECTION_LAYOUT',
      'Repository protection layout is invalid',
    )
  }
  if (handle.descriptor.protection === 'plaintext') return {}

  try {
    const recoveryContent = await readBoundedRegularFile(
      handle.layout.recoveryKey,
      MAX_RECOVERY_KEY_BYTES,
    )
    const wrapped = parseWrappedMasterKey(JSON.parse(recoveryContent.toString('utf8')))
    if (wrapped.repositoryId !== handle.descriptor.repositoryId)
      throw new Error('identity mismatch')
    const keyCheck = await readBoundedRegularFile(handle.layout.keyCheck, MAX_KEY_CHECK_BYTES)
    return { keyCheck }
  } catch {
    throw new RepositoryError(
      'integrity',
      'INVALID_PROTECTION_LAYOUT',
      'Repository protection files are invalid or unsafe',
    )
  }
}

async function cleanupIncompleteRepository(
  repositoryPath: string,
  descriptorTemporaryPath: string,
): Promise<void> {
  const layout = getRepositoryLayout(repositoryPath)
  const files = [layout.descriptor, descriptorTemporaryPath, layout.recoveryKey, layout.keyCheck]
  for (const file of files) {
    try {
      await unlink(file)
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) return
    }
  }

  for (const directory of [
    layout.keys,
    layout.points,
    layout.locks,
    layout.operations,
    layout.root,
  ]) {
    try {
      await rmdir(directory)
    } catch {
      return
    }
  }
}

export function verifyExportedRecoveryMaterial(value: unknown): string {
  let bytes: Buffer
  if (typeof value === 'string') bytes = Buffer.from(value, 'utf8')
  else if (value instanceof Uint8Array) bytes = Buffer.from(value)
  else {
    throw new RepositoryError(
      'authentication',
      'RECOVERY_EXPORT_NOT_VERIFIED',
      'Recovery credential export did not return persisted material for verification',
    )
  }
  if (bytes.length < 1 || bytes.length > MAX_RECOVERY_MATERIAL_BYTES) {
    throw new RepositoryError(
      'authentication',
      'RECOVERY_EXPORT_NOT_VERIFIED',
      'Persisted recovery credential is invalid',
    )
  }
  return bytes.toString('utf8')
}

export async function initializeRepository(
  options: InitializeRepositoryOptions,
): Promise<RepositoryInitResult> {
  const protection = options.protection ?? 'encrypted'
  if (
    protection === 'encrypted' &&
    (!options.credentialProvider || !options.exportRecoveryCredential)
  ) {
    throw new RepositoryError(
      'configuration',
      'RECOVERY_EXPORT_REQUIRED',
      'Encrypted repository initialization requires Keychain storage and an independent recovery credential export',
    )
  }

  const preflight = await preflightTarget(options.targetPath, {
    intent: 'write',
    requiredBytes: options.requiredBytes,
    stableIdentityResolver: options.stableIdentityResolver,
  })
  const repositoryPath = getRepositoryPath(preflight.path)
  const layout = getRepositoryLayout(repositoryPath)
  const repositoryId = randomUUID()
  const createdAtValue = options.now ? options.now() : new Date()
  if (!Number.isFinite(createdAtValue.getTime())) {
    throw new RepositoryError(
      'configuration',
      'INVALID_TIME',
      'Repository creation time is invalid',
    )
  }
  const createdAt = createdAtValue.toISOString()
  const descriptor: RepositoryDescriptor = {
    formatVersion: REPOSITORY_FORMAT_VERSION,
    repositoryId,
    createdAt,
    protection,
    targetIdentity: preflight.identity,
  }
  const descriptorTemporaryPath = `${layout.descriptor}.${repositoryId}.pending`
  let credentialStored = false

  try {
    await mkdir(layout.root, { mode: 0o700 })
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new RepositoryError(
        'destination',
        'REPOSITORY_PATH_OCCUPIED',
        'RestoreBackup already exists; Restore will not take over or overwrite it',
      )
    }
    throw new RepositoryError(
      'destination',
      'REPOSITORY_CREATE_FAILED',
      'Repository could not be created',
    )
  }

  try {
    await syncDirectory(preflight.path)
    await mkdir(layout.keys, { mode: 0o700 })
    await mkdir(layout.points, { mode: 0o700 })
    await mkdir(layout.locks, { mode: 0o700 })
    await mkdir(layout.operations, { mode: 0o700 })
    await syncDirectory(layout.root)

    if (protection === 'encrypted') {
      const masterKey = generateMasterKey()
      const recoverySecret = generateRecoverySecret()
      let importedRecoverySecret: ReturnType<typeof importRecoverySecret> | undefined
      let unwrappedMasterKey: Awaited<ReturnType<typeof unwrapMasterKey>> | undefined

      try {
        const wrappedMasterKey = await wrapMasterKey(repositoryId, masterKey, recoverySecret)
        await writeDurableExclusiveFile(
          layout.recoveryKey,
          `${JSON.stringify(wrappedMasterKey, null, 2)}\n`,
        )

        const protector = createEncryptedProtector(masterKey)
        try {
          const keyCheck = await protector.seal(Buffer.from('restore-cli-key-check-v1'), {
            repositoryId,
            purpose: 'manifest',
            objectId: 'repository-key-check',
          })
          await writeDurableExclusiveFile(layout.keyCheck, keyCheck)
        } finally {
          protector.dispose()
        }
        await syncDirectory(layout.keys)

        const recoveryMaterial = exportRecoverySecret(recoverySecret)
        const persistedMaterial = verifyExportedRecoveryMaterial(
          await options.exportRecoveryCredential?.(recoveryMaterial),
        )
        importedRecoverySecret = importRecoverySecret(persistedMaterial)
        unwrappedMasterKey = await unwrapMasterKey(
          repositoryId,
          wrappedMasterKey,
          importedRecoverySecret,
        )
        if (!masterKey.equals(unwrappedMasterKey)) throw new ProtectionAuthenticationError()

        await options.credentialProvider?.storeMasterKey(repositoryId, masterKey)
        credentialStored = true
      } finally {
        masterKey.dispose()
        recoverySecret.dispose()
        importedRecoverySecret?.dispose()
        unwrappedMasterKey?.dispose()
      }
    }

    await writeDurableExclusiveFile(
      descriptorTemporaryPath,
      `${JSON.stringify(descriptor, null, 2)}\n`,
    )
    await rename(descriptorTemporaryPath, layout.descriptor)
    await syncDirectory(layout.root)
    const publishedDescriptor = await readDescriptor(layout.descriptor)
    if (publishedDescriptor.repositoryId !== repositoryId) {
      throw new RepositoryError(
        'integrity',
        'DESCRIPTOR_PUBLICATION_FAILED',
        'Published repository descriptor could not be verified',
      )
    }
  } catch (error) {
    if (credentialStored) {
      try {
        await options.credentialProvider?.deleteMasterKey(repositoryId)
      } catch {}
    }
    await cleanupIncompleteRepository(repositoryPath, descriptorTemporaryPath)
    if (error instanceof RepositoryError || error instanceof ProtectionError) throw error
    throw new RepositoryError(
      'destination',
      'REPOSITORY_INITIALIZATION_FAILED',
      'Repository initialization did not complete',
    )
  }

  return {
    repositoryPath,
    repositoryId,
    createdAt,
    protection,
    targetIdentity: descriptor.targetIdentity,
    availableBytes: preflight.availableBytes.toString(),
    recoveryCredentialExported: protection === 'encrypted',
  }
}

export async function openRepository(
  repositoryPath: string,
  options: OpenRepositoryOptions,
): Promise<RepositoryHandle> {
  const resolved = resolve(repositoryPath)
  if (basename(resolved) !== REPOSITORY_DIRECTORY_NAME) {
    throw new RepositoryError(
      'destination',
      'INVALID_REPOSITORY_PATH',
      `Repository path must end with ${REPOSITORY_DIRECTORY_NAME}`,
    )
  }

  let repositoryStat: Awaited<ReturnType<typeof lstat>>
  try {
    repositoryStat = await lstat(resolved)
  } catch {
    throw new RepositoryError(
      'destination',
      'REPOSITORY_MISSING',
      'Repository does not exist; Restore will not create a replacement',
    )
  }
  if (!repositoryStat.isDirectory()) {
    throw new RepositoryError(
      'destination',
      'REPOSITORY_NOT_DIRECTORY',
      'Repository is not a directory',
    )
  }

  const layout = getRepositoryLayout(resolved)
  const descriptor = await readDescriptor(layout.descriptor)
  if (descriptor.repositoryId !== options.expectedRepositoryId) {
    throw new RepositoryError(
      'destination',
      'REPOSITORY_IDENTITY_MISMATCH',
      'Repository identity does not match the configured repository',
    )
  }
  if (descriptor.protection !== options.expectedProtection) {
    throw new RepositoryError(
      'integrity',
      'PROTECTION_MODE_MISMATCH',
      'Repository protection mode does not match the configured repository',
    )
  }

  const readPreflight = await preflightTarget(resolved, {
    intent: 'read',
    requiredBytes: options.requiredBytes,
    stableIdentityResolver: options.stableIdentityResolver,
  })
  if (!targetIdentityMatches(readPreflight.identity, descriptor.targetIdentity)) {
    throw new RepositoryError(
      'destination',
      'TARGET_IDENTITY_MISMATCH',
      'Target filesystem identity does not match the initialized repository',
    )
  }

  const readHandle: RepositoryHandle = {
    path: readPreflight.path,
    descriptor,
    layout: getRepositoryLayout(readPreflight.path),
    preflight: readPreflight,
    intent: 'read',
    close() {},
  }
  const protectionFiles = await validateLayout(readHandle)

  let protector: ContentProtector | undefined
  if (descriptor.protection === 'plaintext') protector = createPlaintextProtector()
  else if (options.credentialProvider) {
    protector = await unlockWithCredentialProvider(
      descriptor.repositoryId,
      descriptor.protection,
      options.credentialProvider,
      protectionFiles.keyCheck,
    )
  } else if (options.intent === 'write') {
    throw new ProtectionAuthenticationError()
  }

  let preflight = readPreflight
  try {
    if (options.intent === 'write') {
      preflight = await preflightTarget(resolved, {
        intent: 'write',
        requiredBytes: options.requiredBytes,
        expectedIdentity: descriptor.targetIdentity,
        stableIdentityResolver: options.stableIdentityResolver,
      })
    }
  } catch (error) {
    protector?.dispose()
    throw error
  }

  let closed = false
  const handle: RepositoryHandle = {
    path: preflight.path,
    descriptor,
    layout: getRepositoryLayout(preflight.path),
    preflight,
    intent: options.intent,
    ...(protector ? { protector } : {}),
    close() {
      if (closed) return
      closeRepositoryWrite(handle)
      protector?.dispose()
      closed = true
    },
  }
  if (options.intent === 'write') authorizeRepositoryWrite(handle)
  return handle
}

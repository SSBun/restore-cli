import { lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CredentialProvider } from '../../src/protection/credentials.js'
import { ProtectionAuthenticationError } from '../../src/protection/errors.js'
import {
  MacOsKeychainCredentialProvider,
  SECURITY_EXECUTABLE,
} from '../../src/protection/keychain.js'
import {
  importRecoverySecret,
  parseWrappedMasterKey,
  unwrapMasterKey,
} from '../../src/protection/recovery.js'
import { MasterKey } from '../../src/protection/secrets.js'
import {
  RepositoryError,
  type RepositoryLock,
  acquireRepositoryLock,
  getRepositoryPath,
  initializeRepository,
  openRepository,
  revokeDailyCredential,
  rotateRecoveryCredential,
} from '../../src/repository/index.js'
import { replaceDurableFile } from '../../src/repository/io.js'

class MemoryCredentialProvider implements CredentialProvider {
  readonly keys = new Map<string, Buffer>()

  async storeMasterKey(repositoryId: string, masterKey: MasterKey): Promise<void> {
    this.keys.set(repositoryId, masterKey.copyBytes())
  }

  async loadMasterKey(repositoryId: string): Promise<MasterKey> {
    const key = this.keys.get(repositoryId)
    if (!key) throw new ProtectionAuthenticationError()
    return new MasterKey(key)
  }

  async deleteMasterKey(repositoryId: string): Promise<void> {
    this.keys.get(repositoryId)?.fill(0)
    this.keys.delete(repositoryId)
  }
}

const temporaryDirectories: string[] = []

async function createTarget(prefix = 'restore-encrypted-'): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(target)
  return target
}

async function initializeEncrypted(): Promise<{
  credentials: MemoryCredentialProvider
  recoveryMaterial: string
  result: Awaited<ReturnType<typeof initializeRepository>>
}> {
  const target = await createTarget()
  const credentials = new MemoryCredentialProvider()
  let recoveryMaterial = ''
  const result = await initializeRepository({
    targetPath: target,
    credentialProvider: credentials,
    exportRecoveryCredential: async (material) => {
      recoveryMaterial = material
      return Buffer.from(material)
    },
  })
  return { credentials, recoveryMaterial, result }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('encrypted repository credentials', () => {
  it('stores the daily key, verifies persisted recovery bytes, and returns no secret', async () => {
    const { credentials, recoveryMaterial, result } = await initializeEncrypted()

    expect(result.protection).toBe('encrypted')
    expect(result.recoveryCredentialExported).toBe(true)
    expect(recoveryMaterial).toMatch(/^restore-recovery-v1:/)
    expect(JSON.stringify(result)).not.toContain(recoveryMaterial)
    expect(
      await readFile(join(result.repositoryPath, 'keys', 'recovery.json'), 'utf8'),
    ).not.toContain(recoveryMaterial)

    const opened = await openRepository(result.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: result.repositoryId,
      expectedProtection: 'encrypted',
      credentialProvider: credentials,
    })
    expect(opened.protector?.mode).toBe('encrypted')
    opened.close()
  })

  it('rejects no-op, corrupt, and pre-publication credential failures without a descriptor', async () => {
    const noOpTarget = await createTarget('restore-no-op-export-')
    await expect(
      initializeRepository({
        targetPath: noOpTarget,
        credentialProvider: new MemoryCredentialProvider(),
        exportRecoveryCredential: (async () => undefined) as never,
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_EXPORT_NOT_VERIFIED' })
    await expect(lstat(getRepositoryPath(noOpTarget))).rejects.toMatchObject({ code: 'ENOENT' })

    const corruptTarget = await createTarget('restore-corrupt-export-')
    await expect(
      initializeRepository({
        targetPath: corruptTarget,
        credentialProvider: new MemoryCredentialProvider(),
        exportRecoveryCredential: async () => Buffer.from('corrupt'),
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
    await expect(lstat(getRepositoryPath(corruptTarget))).rejects.toMatchObject({ code: 'ENOENT' })

    const publicationTarget = await createTarget('restore-publication-failure-')
    await expect(
      initializeRepository({
        targetPath: publicationTarget,
        credentialProvider: {
          async storeMasterKey() {
            throw new Error('injected store failure')
          },
          async loadMasterKey() {
            throw new Error('not used')
          },
          async deleteMasterKey() {},
        },
        exportRecoveryCredential: async (material) => Buffer.from(material),
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_INITIALIZATION_FAILED' })
    await expect(lstat(getRepositoryPath(publicationTarget))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('authenticates encrypted write-open before any target capability mutation', async () => {
    const { credentials, result } = await initializeEncrypted()
    const before = await stat(result.repositoryPath, { bigint: true })
    const wrongCredentials = new MemoryCredentialProvider()
    const wrongKey = new MasterKey(Buffer.alloc(32, 9))
    await wrongCredentials.storeMasterKey(result.repositoryId, wrongKey)
    wrongKey.dispose()

    await expect(
      openRepository(result.repositoryPath, {
        intent: 'write',
        expectedRepositoryId: result.repositoryId,
        expectedProtection: 'encrypted',
        credentialProvider: wrongCredentials,
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
    await expect(
      openRepository(result.repositoryPath, {
        intent: 'write',
        expectedRepositoryId: result.repositoryId,
        expectedProtection: 'encrypted',
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })

    const afterFailures = await stat(result.repositoryPath, { bigint: true })
    expect(afterFailures.mtimeNs).toBe(before.mtimeNs)

    const writable = await openRepository(result.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: result.repositoryId,
      expectedProtection: 'encrypted',
      credentialProvider: credentials,
    })
    expect(writable.preflight.capabilities.writeChecked).toBe(true)
    expect(writable.protector?.mode).toBe('encrypted')
    writable.close()
    await expect(acquireRepositoryLock(writable, 'after-close')).rejects.toMatchObject({
      code: 'WRITE_AUTHORIZATION_REQUIRED',
    })
  })

  it('rotates only the current recovery wrapper atomically and can revoke daily access', async () => {
    const { credentials, recoveryMaterial: oldMaterial, result } = await initializeEncrypted()
    const repository = await openRepository(result.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: result.repositoryId,
      expectedProtection: 'encrypted',
      credentialProvider: credentials,
    })
    const oldWrapperBytes = await readFile(repository.layout.recoveryKey)
    const oldWrapper = parseWrappedMasterKey(JSON.parse(oldWrapperBytes.toString('utf8')))
    const keyCheckBefore = await readFile(repository.layout.keyCheck)
    const context = {
      repositoryId: result.repositoryId,
      purpose: 'blob' as const,
      objectId: 'rotation-fixture',
    }
    const blob = await repository.protector?.seal(Buffer.from('unchanged blob'), context)
    let newMaterial = ''

    const rotation = await rotateRecoveryCredential(
      repository,
      credentials,
      async (material) => {
        newMaterial = material
        return Buffer.from(material)
      },
      new Date('2026-07-18T00:00:00.000Z'),
    )
    expect(JSON.stringify(rotation)).not.toContain(newMaterial)
    expect(rotation.rotatedAt).toBe('2026-07-18T00:00:00.000Z')
    expect(await readFile(repository.layout.keyCheck)).toEqual(keyCheckBefore)
    await expect(repository.protector?.open(blob ?? Buffer.alloc(0), context)).resolves.toEqual(
      Buffer.from('unchanged blob'),
    )

    const currentWrapperBytes = await readFile(repository.layout.recoveryKey)
    const currentWrapper = parseWrappedMasterKey(JSON.parse(currentWrapperBytes.toString('utf8')))
    const newSecret = importRecoverySecret(newMaterial)
    const newMaster = await unwrapMasterKey(result.repositoryId, currentWrapper, newSecret)
    const oldSecret = importRecoverySecret(oldMaterial)
    await expect(
      unwrapMasterKey(result.repositoryId, currentWrapper, oldSecret),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })

    const copiedOldMaster = await unwrapMasterKey(result.repositoryId, oldWrapper, oldSecret)
    expect(copiedOldMaster.equals(newMaster)).toBe(true)

    await expect(
      rotateRecoveryCredential(repository, credentials, async () => Buffer.from('corrupt')),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
    expect(await readFile(repository.layout.recoveryKey)).toEqual(currentWrapperBytes)
    const stillUsable = await unwrapMasterKey(result.repositoryId, currentWrapper, newSecret)

    await revokeDailyCredential(repository, credentials)
    expect(credentials.keys.has(result.repositoryId)).toBe(false)
    await expect(acquireRepositoryLock(repository, 'after-revoke')).rejects.toMatchObject({
      code: 'WRITE_AUTHORIZATION_REQUIRED',
    })

    newSecret.dispose()
    oldSecret.dispose()
    newMaster.dispose()
    copiedOldMaster.dispose()
    stillUsable.dispose()
  })

  it('separates pre-commit failure from lock cleanup failure', async () => {
    const { credentials, result } = await initializeEncrypted()
    const repository = await openRepository(result.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: result.repositoryId,
      expectedProtection: 'encrypted',
      credentialProvider: credentials,
    })
    const wrapperBefore = await readFile(repository.layout.recoveryKey)
    const acquireWithFailingRelease = async (...args: Parameters<typeof acquireRepositoryLock>) => {
      const lock = await acquireRepositoryLock(...args)
      return {
        metadata: lock.metadata,
        async release() {
          await lock.release()
          throw new RepositoryError('lock', 'INJECTED_RELEASE_FAILURE', 'not surfaced')
        },
      } satisfies RepositoryLock
    }

    await expect(
      rotateRecoveryCredential(
        repository,
        credentials,
        async () => Buffer.from('corrupt'),
        new Date('2026-07-18T00:00:00.000Z'),
        { acquireLock: acquireWithFailingRelease },
      ),
    ).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      lockCleanup: { status: 'failed', code: 'INJECTED_RELEASE_FAILURE' },
    })
    expect(await readFile(repository.layout.recoveryKey)).toEqual(wrapperBefore)
  })

  it('reports committed rotation and revocation even when lock cleanup fails', async () => {
    const first = await initializeEncrypted()
    const rotationRepository = await openRepository(first.result.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: first.result.repositoryId,
      expectedProtection: 'encrypted',
      credentialProvider: first.credentials,
    })
    const acquireWithFailingRelease = async (...args: Parameters<typeof acquireRepositoryLock>) => {
      const lock = await acquireRepositoryLock(...args)
      return {
        metadata: lock.metadata,
        async release() {
          await lock.release()
          throw new RepositoryError('lock', 'INJECTED_RELEASE_FAILURE', 'not surfaced')
        },
      } satisfies RepositoryLock
    }
    let newMaterial = ''
    const rotation = await rotateRecoveryCredential(
      rotationRepository,
      first.credentials,
      async (material) => {
        newMaterial = material
        return Buffer.from(material)
      },
      new Date('2026-07-18T00:00:00.000Z'),
      { acquireLock: acquireWithFailingRelease },
    )
    expect(rotation).toMatchObject({
      committed: true,
      currentWrapperReplaced: true,
      commitDurability: { status: 'synced' },
      lockCleanup: { status: 'failed', code: 'INJECTED_RELEASE_FAILURE' },
    })
    const wrapper = parseWrappedMasterKey(
      JSON.parse(await readFile(rotationRepository.layout.recoveryKey, 'utf8')),
    )
    const secret = importRecoverySecret(newMaterial)
    const master = await unwrapMasterKey(first.result.repositoryId, wrapper, secret)
    master.dispose()
    secret.dispose()

    const second = await initializeEncrypted()
    const revokeRepository = await openRepository(second.result.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: second.result.repositoryId,
      expectedProtection: 'encrypted',
      credentialProvider: second.credentials,
    })
    const revocation = await revokeDailyCredential(revokeRepository, second.credentials, {
      acquireLock: acquireWithFailingRelease,
    })
    expect(revocation).toMatchObject({
      credentialDeleted: true,
      repositoryClosed: true,
      lockCleanup: { status: 'failed', code: 'INJECTED_RELEASE_FAILURE' },
    })
    expect(second.credentials.keys.has(second.result.repositoryId)).toBe(false)
    await expect(acquireRepositoryLock(revokeRepository, 'after-revoke')).rejects.toMatchObject({
      code: 'WRITE_AUTHORIZATION_REQUIRED',
    })
  })

  it('reports a committed wrapper with failed directory durability through the injected seam', async () => {
    const { credentials, recoveryMaterial: oldMaterial, result } = await initializeEncrypted()
    const repository = await openRepository(result.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: result.repositoryId,
      expectedProtection: 'encrypted',
      credentialProvider: credentials,
    })
    let newMaterial = ''
    const rotation = await rotateRecoveryCredential(
      repository,
      credentials,
      async (material) => {
        newMaterial = material
        return Buffer.from(material)
      },
      new Date('2026-07-19T00:00:00.000Z'),
      {
        replaceDurableFile: async (...args) => {
          const committed = await replaceDurableFile(...args)
          expect(committed.committed).toBe(true)
          return {
            committed: true,
            directorySync: { status: 'failed', code: 'DIRECTORY_SYNC_FAILED' },
          }
        },
      },
    )

    expect(rotation).toMatchObject({
      committed: true,
      currentWrapperReplaced: true,
      commitDurability: { status: 'failed', code: 'DIRECTORY_SYNC_FAILED' },
      lockCleanup: { status: 'released' },
    })
    const wrapper = parseWrappedMasterKey(
      JSON.parse(await readFile(repository.layout.recoveryKey, 'utf8')),
    )
    const newSecret = importRecoverySecret(newMaterial)
    const newMaster = await unwrapMasterKey(result.repositoryId, wrapper, newSecret)
    const oldSecret = importRecoverySecret(oldMaterial)
    await expect(unwrapMasterKey(result.repositoryId, wrapper, oldSecret)).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    })
    newMaster.dispose()
    newSecret.dispose()
    oldSecret.dispose()
  })

  it('closes after a failed delete and preserves its primary code over release failure', async () => {
    const { credentials, result } = await initializeEncrypted()
    const repository = await openRepository(result.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: result.repositoryId,
      expectedProtection: 'encrypted',
      credentialProvider: credentials,
    })
    const acquireWithFailingRelease = async (...args: Parameters<typeof acquireRepositoryLock>) => {
      const lock = await acquireRepositoryLock(...args)
      return {
        metadata: lock.metadata,
        async release() {
          await lock.release()
          throw new RepositoryError('lock', 'INJECTED_RELEASE_FAILURE', 'not surfaced')
        },
      } satisfies RepositoryLock
    }
    const failingDelete: CredentialProvider = {
      storeMasterKey: (...args) => credentials.storeMasterKey(...args),
      loadMasterKey: (...args) => credentials.loadMasterKey(...args),
      async deleteMasterKey() {
        throw new RepositoryError('authentication', 'DELETE_FAILED', 'primary failure')
      },
    }

    await expect(
      revokeDailyCredential(repository, failingDelete, { acquireLock: acquireWithFailingRelease }),
    ).rejects.toMatchObject({
      code: 'DELETE_FAILED',
      credentialDeletion: 'unknown',
      repositoryClosed: true,
      lockCleanup: { status: 'failed', code: 'INJECTED_RELEASE_FAILURE' },
    })
    await expect(acquireRepositoryLock(repository, 'after-failed-revoke')).rejects.toMatchObject({
      code: 'WRITE_AUTHORIZATION_REQUIRED',
    })
  })
})

describe('macOS Keychain adapter', () => {
  it('uses the absolute security binary and passes the secret only through stdin', async () => {
    const repositoryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const rawKey = Buffer.alloc(32, 7)
    const masterKey = new MasterKey(rawKey)
    const calls: Array<{
      executable: string
      arguments_: readonly string[]
      input?: Buffer
    }> = []
    const provider = new MacOsKeychainCredentialProvider(async (executable, arguments_, input) => {
      calls.push({ executable, arguments_, input: input ? Buffer.from(input) : undefined })
      if (arguments_[0] === 'find-generic-password') {
        return Buffer.from(`${rawKey.toString('base64')}\n`)
      }
      return Buffer.alloc(0)
    })

    await provider.storeMasterKey(repositoryId, masterKey)
    const loaded = await provider.loadMasterKey(repositoryId)
    await provider.deleteMasterKey(repositoryId)

    const store = calls[0]
    expect(calls.every((call) => call.executable === SECURITY_EXECUTABLE)).toBe(true)
    expect(store.arguments_.at(-1)).toBe('-w')
    expect(store.arguments_.join(' ')).not.toContain(rawKey.toString('base64'))
    expect(store.input?.toString('utf8').trim()).toBe(rawKey.toString('base64'))
    expect(loaded.equals(masterKey)).toBe(true)
    expect(JSON.stringify(masterKey)).toBe('"[REDACTED]"')

    loaded.dispose()
    masterKey.dispose()
  })
})

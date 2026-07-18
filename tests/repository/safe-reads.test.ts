import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { CredentialProvider } from '../../src/protection/credentials.js'
import { ProtectionAuthenticationError } from '../../src/protection/errors.js'
import { MasterKey } from '../../src/protection/secrets.js'
import {
  initializeRepository,
  inspectRepositoryLock,
  listOperationResults,
  openRepository,
} from '../../src/repository/index.js'

const run = promisify(execFile)
const temporaryDirectories: string[] = []

class MemoryCredentials implements CredentialProvider {
  key?: Buffer

  async storeMasterKey(_repositoryId: string, masterKey: MasterKey): Promise<void> {
    this.key = masterKey.copyBytes()
  }

  async loadMasterKey(): Promise<MasterKey> {
    if (!this.key) throw new ProtectionAuthenticationError()
    return new MasterKey(this.key)
  }

  async deleteMasterKey(): Promise<void> {
    this.key?.fill(0)
    this.key = undefined
  }
}

async function target(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('bounded no-follow repository reads', () => {
  it('rejects descriptor symlinks and FIFOs without following or blocking', async () => {
    const symlinkTarget = await target('restore-safe-descriptor-link-')
    const linked = await initializeRepository({
      targetPath: symlinkTarget,
      protection: 'plaintext',
    })
    const descriptor = join(linked.repositoryPath, 'repository.json')
    const realDescriptor = join(linked.repositoryPath, 'descriptor.real')
    await rename(descriptor, realDescriptor)
    await symlink(realDescriptor, descriptor)
    await expect(
      openRepository(linked.repositoryPath, {
        intent: 'read',
        expectedRepositoryId: linked.repositoryId,
        expectedProtection: 'plaintext',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DESCRIPTOR' })

    const fifoTarget = await target('restore-safe-descriptor-fifo-')
    const fifo = await initializeRepository({ targetPath: fifoTarget, protection: 'plaintext' })
    const fifoDescriptor = join(fifo.repositoryPath, 'repository.json')
    await unlink(fifoDescriptor)
    await run('/usr/bin/mkfifo', [fifoDescriptor])
    await expect(
      openRepository(fifo.repositoryPath, {
        intent: 'read',
        expectedRepositoryId: fifo.repositoryId,
        expectedProtection: 'plaintext',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DESCRIPTOR' })
  })

  it('rejects unsafe key files before credential use', async () => {
    const encryptedTarget = await target('restore-safe-key-')
    const credentials = new MemoryCredentials()
    const initialized = await initializeRepository({
      targetPath: encryptedTarget,
      credentialProvider: credentials,
      exportRecoveryCredential: async (material) => Buffer.from(material),
    })
    const recoveryKey = join(initialized.repositoryPath, 'keys', 'recovery.json')
    const realRecoveryKey = `${recoveryKey}.real`
    await rename(recoveryKey, realRecoveryKey)
    await symlink(realRecoveryKey, recoveryKey)

    await expect(
      openRepository(initialized.repositoryPath, {
        intent: 'read',
        expectedRepositoryId: initialized.repositoryId,
        expectedProtection: 'encrypted',
        credentialProvider: credentials,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROTECTION_LAYOUT' })
  })

  it('rejects symlink, FIFO, and oversized history or lock metadata promptly', async () => {
    const plainTarget = await target('restore-safe-history-')
    const initialized = await initializeRepository({
      targetPath: plainTarget,
      protection: 'plaintext',
    })
    const repository = await openRepository(initialized.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: initialized.repositoryId,
      expectedProtection: 'plaintext',
    })

    const historyPath = join(repository.layout.operations, 'unsafe.json')
    await symlink(repository.layout.descriptor, historyPath)
    await expect(listOperationResults(repository)).rejects.toMatchObject({
      code: 'INVALID_OPERATION_HISTORY',
    })
    await unlink(historyPath)
    await writeFile(historyPath, Buffer.alloc(1024 * 1024 + 1))
    await expect(listOperationResults(repository)).rejects.toMatchObject({
      code: 'INVALID_OPERATION_HISTORY',
    })
    await unlink(historyPath)
    await run('/usr/bin/mkfifo', [historyPath])
    await expect(listOperationResults(repository)).rejects.toMatchObject({
      code: 'INVALID_OPERATION_HISTORY',
    })

    await mkdir(repository.layout.repositoryLock)
    await run('/usr/bin/mkfifo', [join(repository.layout.repositoryLock, 'owner.json')])
    await expect(inspectRepositoryLock(repository)).resolves.toMatchObject({
      state: 'locked',
      metadata: null,
    })
  })
})

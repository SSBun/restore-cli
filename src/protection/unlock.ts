import type { CredentialProvider } from './credentials.js'
import {
  type ContentProtector,
  createEncryptedProtector,
  createPlaintextProtector,
} from './crypto.js'
import { ProtectionAuthenticationError } from './errors.js'
import { importRecoverySecret, parseWrappedMasterKey, unwrapMasterKey } from './recovery.js'
import type { MasterKey } from './secrets.js'

const KEY_CHECK_CONTENT = Buffer.from('restore-cli-key-check-v1')

export async function unlockWithCredentialProvider(
  repositoryId: string,
  protection: 'encrypted' | 'plaintext',
  credentialProvider: CredentialProvider,
  keyCheck?: Uint8Array,
): Promise<ContentProtector> {
  if (protection === 'plaintext') return createPlaintextProtector()
  if (!keyCheck) throw new ProtectionAuthenticationError()

  const masterKey = await credentialProvider.loadMasterKey(repositoryId)
  try {
    return await authenticateMasterKey(repositoryId, masterKey, keyCheck)
  } finally {
    masterKey.dispose()
  }
}

export async function authenticateMasterKey(
  repositoryId: string,
  masterKey: MasterKey,
  keyCheck: Uint8Array,
): Promise<ContentProtector> {
  const protector = createEncryptedProtector(masterKey)
  try {
    const opened = await protector.open(keyCheck, {
      repositoryId,
      purpose: 'manifest',
      objectId: 'repository-key-check',
    })
    if (!opened.equals(KEY_CHECK_CONTENT)) throw new ProtectionAuthenticationError()
    return protector
  } catch {
    protector.dispose()
    throw new ProtectionAuthenticationError()
  }
}

export async function unlockWithRecoveryCredential(
  repositoryId: string,
  wrappedMasterKey: unknown,
  recoveryMaterial: string,
  credentialProvider?: CredentialProvider,
): Promise<ContentProtector> {
  const recoverySecret = importRecoverySecret(recoveryMaterial)
  let masterKey: Awaited<ReturnType<typeof unwrapMasterKey>> | undefined

  try {
    masterKey = await unwrapMasterKey(
      repositoryId,
      parseWrappedMasterKey(wrappedMasterKey),
      recoverySecret,
    )
    if (credentialProvider) await credentialProvider.storeMasterKey(repositoryId, masterKey)
    return createEncryptedProtector(masterKey)
  } finally {
    masterKey?.dispose()
    recoverySecret.dispose()
  }
}

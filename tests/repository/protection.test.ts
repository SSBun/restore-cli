import { describe, expect, it } from 'vitest'
import {
  ProtectionAuthenticationError,
  createEncryptedProtector,
  createPlaintextProtector,
  exportRecoverySecret,
  generateMasterKey,
  generateRecoverySecret,
  importRecoverySecret,
  importRecoverySecretBytes,
  unlockWithRecoveryCredential,
  unwrapMasterKey,
  wrapMasterKey,
} from '../../src/protection/index.js'

const blobContext = {
  repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  purpose: 'blob' as const,
  objectId: 'blob-1',
}

describe('content protection', () => {
  it('round-trips explicit plaintext and encrypted blob/manifest envelopes', async () => {
    const plaintext = createPlaintextProtector()
    const plainEnvelope = await plaintext.seal(Buffer.from('plain'), blobContext)
    await expect(plaintext.open(plainEnvelope, blobContext)).resolves.toEqual(Buffer.from('plain'))

    const masterKey = generateMasterKey()
    const encrypted = createEncryptedProtector(masterKey)
    const blobEnvelope = await encrypted.seal(Buffer.from('blob contents'), blobContext)
    const manifestContext = { ...blobContext, purpose: 'manifest' as const, objectId: 'point-1' }
    const manifestEnvelope = await encrypted.seal(
      Buffer.from('{"formatVersion":1}'),
      manifestContext,
    )

    await expect(encrypted.open(blobEnvelope, blobContext)).resolves.toEqual(
      Buffer.from('blob contents'),
    )
    await expect(encrypted.open(manifestEnvelope, manifestContext)).resolves.toEqual(
      Buffer.from('{"formatVersion":1}'),
    )
    expect(blobEnvelope).not.toContain(Buffer.from('blob contents'))

    encrypted.dispose()
    masterKey.dispose()
  })

  it('rejects a wrong key, tampering, and cross-object substitution', async () => {
    const masterKey = generateMasterKey()
    const wrongKey = generateMasterKey()
    const encrypted = createEncryptedProtector(masterKey)
    const wrongProtector = createEncryptedProtector(wrongKey)
    const envelope = await encrypted.seal(Buffer.from('sensitive'), blobContext)

    await expect(wrongProtector.open(envelope, blobContext)).rejects.toBeInstanceOf(
      ProtectionAuthenticationError,
    )

    const tampered = Buffer.from(envelope)
    tampered[tampered.length - 1] ^= 1
    await expect(encrypted.open(tampered, blobContext)).rejects.toBeInstanceOf(
      ProtectionAuthenticationError,
    )
    await expect(
      encrypted.open(envelope, { ...blobContext, objectId: 'blob-2' }),
    ).rejects.toBeInstanceOf(ProtectionAuthenticationError)

    encrypted.dispose()
    wrongProtector.dispose()
    masterKey.dispose()
    wrongKey.dispose()
  })
})

describe('recovery credential wrapping', () => {
  it('exports, reimports, wraps, and unwraps the independent master key', async () => {
    const masterKey = generateMasterKey()
    const recoverySecret = generateRecoverySecret()
    const material = exportRecoverySecret(recoverySecret)
    const imported = importRecoverySecret(material)
    const wrapped = await wrapMasterKey(blobContext.repositoryId, masterKey, imported)
    const unwrapped = await unwrapMasterKey(blobContext.repositoryId, wrapped, imported)

    expect(masterKey.equals(unwrapped)).toBe(true)
    expect(JSON.stringify(wrapped)).not.toContain(material)
    expect(JSON.stringify(recoverySecret)).toBe('"[REDACTED]"')

    const wrongSecret = generateRecoverySecret()
    await expect(
      unwrapMasterKey(blobContext.repositoryId, wrapped, wrongSecret),
    ).rejects.toBeInstanceOf(ProtectionAuthenticationError)

    const wrongMaterial = exportRecoverySecret(wrongSecret)
    let credentialWrites = 0
    await expect(
      unlockWithRecoveryCredential(blobContext.repositoryId, wrapped, wrongMaterial, {
        async storeMasterKey() {
          credentialWrites++
        },
        async loadMasterKey() {
          throw new Error('not used')
        },
        async deleteMasterKey() {},
      }),
    ).rejects.toBeInstanceOf(ProtectionAuthenticationError)
    expect(credentialWrites).toBe(0)

    masterKey.dispose()
    recoverySecret.dispose()
    imported.dispose()
    unwrapped.dispose()
    wrongSecret.dispose()
  })

  it('imports exact recovery credential bytes without a secret-bearing JS string', async () => {
    const source = generateRecoverySecret()
    const material = Buffer.from(exportRecoverySecret(source), 'ascii')
    const imported = importRecoverySecretBytes(material)
    const masterKey = generateMasterKey()
    const wrapped = await wrapMasterKey(blobContext.repositoryId, masterKey, imported)
    const unwrapped = await unwrapMasterKey(blobContext.repositoryId, wrapped, imported)
    expect(masterKey.equals(unwrapped)).toBe(true)

    const nonCanonical = Buffer.from(material)
    nonCanonical[nonCanonical.length - 1] = 95
    await expect(() => importRecoverySecretBytes(nonCanonical)).toThrow(
      ProtectionAuthenticationError,
    )

    material.fill(0)
    nonCanonical.fill(0)
    source.dispose()
    imported.dispose()
    masterKey.dispose()
    unwrapped.dispose()
  })
})

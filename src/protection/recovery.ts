import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { ProtectionAuthenticationError, ProtectionError } from './errors.js'
import { MasterKey, RecoverySecret } from './secrets.js'

const RECOVERY_SECRET_PREFIX = 'restore-recovery-v1:'
const RECOVERY_SECRET_PREFIX_BYTES = Buffer.from(RECOVERY_SECRET_PREFIX, 'ascii')
const RECOVERY_SECRET_ENCODED_BYTES = 43
const WRAP_FORMAT_VERSION = 1 as const
const ALGORITHM = 'aes-256-gcm' as const
const NONCE_LENGTH = 12
const TAG_LENGTH = 16
const SCRYPT_COST = 16_384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
const SCRYPT_KEY_LENGTH = 32
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024

export interface WrappedMasterKey {
  formatVersion: typeof WRAP_FORMAT_VERSION
  repositoryId: string
  keyDerivation: {
    name: 'scrypt'
    salt: string
    cost: typeof SCRYPT_COST
    blockSize: typeof SCRYPT_BLOCK_SIZE
    parallelization: typeof SCRYPT_PARALLELIZATION
    keyLength: typeof SCRYPT_KEY_LENGTH
  }
  cipher: {
    name: typeof ALGORITHM
    nonce: string
    authenticationTag: string
    ciphertext: string
  }
}

function deriveWrappingKey(secret: RecoverySecret, salt: Buffer): Promise<Buffer> {
  const secretBytes = secret.copyBytes()

  return new Promise((resolve, reject) => {
    scrypt(
      secretBytes,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        secretBytes.fill(0)
        if (error)
          reject(new ProtectionError('KEY_DERIVATION_FAILED', 'Credential processing failed'))
        else resolve(Buffer.from(derivedKey))
      },
    )
  })
}

function wrapAad(repositoryId: string): Buffer {
  return Buffer.from(`restore-cli-master-key\0${WRAP_FORMAT_VERSION}\0${repositoryId}`, 'utf8')
}

function decodeExact(value: string, length: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProtectionError('INVALID_RECOVERY_KEY_FORMAT', 'Recovery key file is invalid')
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== length || decoded.toString('base64url') !== value) {
    throw new ProtectionError('INVALID_RECOVERY_KEY_FORMAT', 'Recovery key file is invalid')
  }
  return decoded
}

export function generateRecoverySecret(): RecoverySecret {
  return new RecoverySecret(randomBytes(32))
}

export function exportRecoverySecret(secret: RecoverySecret): string {
  const bytes = secret.copyBytes()
  try {
    return `${RECOVERY_SECRET_PREFIX}${bytes.toString('base64url')}`
  } finally {
    bytes.fill(0)
  }
}

export function importRecoverySecret(material: string): RecoverySecret {
  const bytes = Buffer.from(material, 'utf8')
  try {
    return importRecoverySecretBytes(bytes)
  } finally {
    bytes.fill(0)
  }
}

function base64UrlValue(byte: number): number {
  if (byte >= 65 && byte <= 90) return byte - 65
  if (byte >= 97 && byte <= 122) return byte - 97 + 26
  if (byte >= 48 && byte <= 57) return byte - 48 + 52
  if (byte === 45) return 62
  if (byte === 95) return 63
  return -1
}

export function importRecoverySecretBytes(material: Uint8Array): RecoverySecret {
  const bytes = Buffer.from(material.buffer, material.byteOffset, material.byteLength)
  if (
    bytes.length !== RECOVERY_SECRET_PREFIX_BYTES.length + RECOVERY_SECRET_ENCODED_BYTES ||
    !bytes.subarray(0, RECOVERY_SECRET_PREFIX_BYTES.length).equals(RECOVERY_SECRET_PREFIX_BYTES)
  ) {
    throw new ProtectionAuthenticationError()
  }
  const decoded = Buffer.alloc(32)
  let accumulator = 0
  let bits = 0
  let offset = 0
  try {
    for (const byte of bytes.subarray(RECOVERY_SECRET_PREFIX_BYTES.length)) {
      const value = base64UrlValue(byte)
      if (value < 0) throw new ProtectionAuthenticationError()
      accumulator = (accumulator << 6) | value
      bits += 6
      if (bits >= 8) {
        bits -= 8
        if (offset >= decoded.length) throw new ProtectionAuthenticationError()
        decoded[offset] = (accumulator >> bits) & 0xff
        offset += 1
        accumulator &= (1 << bits) - 1
      }
    }
    if (offset !== decoded.length || bits !== 2 || accumulator !== 0) {
      throw new ProtectionAuthenticationError()
    }
    return new RecoverySecret(decoded)
  } catch {
    throw new ProtectionAuthenticationError()
  } finally {
    decoded.fill(0)
    accumulator = 0
    bits = 0
    offset = 0
  }
}

export async function wrapMasterKey(
  repositoryId: string,
  masterKey: MasterKey,
  recoverySecret: RecoverySecret,
): Promise<WrappedMasterKey> {
  const salt = randomBytes(16)
  const nonce = randomBytes(NONCE_LENGTH)
  const wrappingKey = await deriveWrappingKey(recoverySecret, salt)
  const masterKeyBytes = masterKey.copyBytes()

  try {
    const cipher = createCipheriv(ALGORITHM, wrappingKey, nonce, { authTagLength: TAG_LENGTH })
    cipher.setAAD(wrapAad(repositoryId))
    const ciphertext = Buffer.concat([cipher.update(masterKeyBytes), cipher.final()])

    return {
      formatVersion: WRAP_FORMAT_VERSION,
      repositoryId,
      keyDerivation: {
        name: 'scrypt',
        salt: salt.toString('base64url'),
        cost: SCRYPT_COST,
        blockSize: SCRYPT_BLOCK_SIZE,
        parallelization: SCRYPT_PARALLELIZATION,
        keyLength: SCRYPT_KEY_LENGTH,
      },
      cipher: {
        name: ALGORITHM,
        nonce: nonce.toString('base64url'),
        authenticationTag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      },
    }
  } finally {
    wrappingKey.fill(0)
    masterKeyBytes.fill(0)
  }
}

function validateWrappedMasterKey(value: WrappedMasterKey, repositoryId: string): void {
  if (
    value.formatVersion !== WRAP_FORMAT_VERSION ||
    value.repositoryId !== repositoryId ||
    value.keyDerivation.name !== 'scrypt' ||
    value.keyDerivation.cost !== SCRYPT_COST ||
    value.keyDerivation.blockSize !== SCRYPT_BLOCK_SIZE ||
    value.keyDerivation.parallelization !== SCRYPT_PARALLELIZATION ||
    value.keyDerivation.keyLength !== SCRYPT_KEY_LENGTH ||
    value.cipher.name !== ALGORITHM
  ) {
    throw new ProtectionAuthenticationError()
  }
}

export async function unwrapMasterKey(
  repositoryId: string,
  wrapped: WrappedMasterKey,
  recoverySecret: RecoverySecret,
): Promise<MasterKey> {
  validateWrappedMasterKey(wrapped, repositoryId)

  let salt: Buffer
  let nonce: Buffer
  let authenticationTag: Buffer
  let ciphertext: Buffer
  try {
    salt = decodeExact(wrapped.keyDerivation.salt, 16)
    nonce = decodeExact(wrapped.cipher.nonce, NONCE_LENGTH)
    authenticationTag = decodeExact(wrapped.cipher.authenticationTag, TAG_LENGTH)
    ciphertext = decodeExact(wrapped.cipher.ciphertext, 32)
  } catch {
    throw new ProtectionAuthenticationError()
  }

  const wrappingKey = await deriveWrappingKey(recoverySecret, salt)
  try {
    const decipher = createDecipheriv(ALGORITHM, wrappingKey, nonce, { authTagLength: TAG_LENGTH })
    decipher.setAAD(wrapAad(repositoryId))
    decipher.setAuthTag(authenticationTag)
    return new MasterKey(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
  } catch {
    throw new ProtectionAuthenticationError()
  } finally {
    wrappingKey.fill(0)
  }
}

export function parseWrappedMasterKey(value: unknown): WrappedMasterKey {
  if (!value || typeof value !== 'object') {
    throw new ProtectionError('INVALID_RECOVERY_KEY_FORMAT', 'Recovery key file is invalid')
  }

  const candidate = value as Partial<WrappedMasterKey>
  if (
    !candidate.keyDerivation ||
    !candidate.cipher ||
    typeof candidate.repositoryId !== 'string' ||
    typeof candidate.keyDerivation.salt !== 'string' ||
    typeof candidate.cipher.nonce !== 'string' ||
    typeof candidate.cipher.authenticationTag !== 'string' ||
    typeof candidate.cipher.ciphertext !== 'string'
  ) {
    throw new ProtectionError('INVALID_RECOVERY_KEY_FORMAT', 'Recovery key file is invalid')
  }

  return candidate as WrappedMasterKey
}

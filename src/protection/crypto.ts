import { type CipherGCMTypes, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ProtectionAuthenticationError, ProtectionError } from './errors.js'
import { MasterKey } from './secrets.js'

const ENVELOPE_MAGIC = Buffer.from('RSTBKP01', 'ascii')
const ENVELOPE_FORMAT_VERSION = 1
const PLAINTEXT_MODE = 0
const ENCRYPTED_MODE = 1
const HEADER_LENGTH = ENVELOPE_MAGIC.length + 2
const NONCE_LENGTH = 12
const AUTHENTICATION_TAG_LENGTH = 16
const ALGORITHM: CipherGCMTypes = 'aes-256-gcm'

export type ProtectedContentPurpose = 'blob' | 'manifest'

export interface ProtectionContext {
  repositoryId: string
  purpose: ProtectedContentPurpose
  objectId: string
}

export interface ContentProtector {
  readonly mode: 'encrypted' | 'plaintext'
  seal(plaintext: Uint8Array, context: ProtectionContext): Promise<Buffer>
  open(protectedContent: Uint8Array, context: ProtectionContext): Promise<Buffer>
  dispose(): void
}

function validateContext(context: ProtectionContext): void {
  if (
    !context.repositoryId ||
    !context.objectId ||
    context.repositoryId.includes('\0') ||
    context.objectId.includes('\0')
  ) {
    throw new ProtectionError('INVALID_PROTECTION_CONTEXT', 'Protection context is invalid')
  }
}

function contextAad(context: ProtectionContext): Buffer {
  validateContext(context)
  return Buffer.from(
    `restore-cli\0${ENVELOPE_FORMAT_VERSION}\0${context.repositoryId}\0${context.purpose}\0${context.objectId}`,
    'utf8',
  )
}

function header(mode: number): Buffer {
  return Buffer.concat([ENVELOPE_MAGIC, Buffer.from([ENVELOPE_FORMAT_VERSION, mode])])
}

function parseEnvelope(content: Uint8Array): { mode: number; payload: Buffer } {
  const envelope = Buffer.from(content)
  if (
    envelope.length < HEADER_LENGTH ||
    !envelope.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC) ||
    envelope[ENVELOPE_MAGIC.length] !== ENVELOPE_FORMAT_VERSION
  ) {
    throw new ProtectionError(
      'UNSUPPORTED_PROTECTION_FORMAT',
      'Protected content format is invalid',
    )
  }

  return {
    mode: envelope[ENVELOPE_MAGIC.length + 1],
    payload: envelope.subarray(HEADER_LENGTH),
  }
}

export function generateMasterKey(): MasterKey {
  return new MasterKey(randomBytes(32))
}

export function createPlaintextProtector(): ContentProtector {
  return {
    mode: 'plaintext',
    async seal(plaintext, context) {
      validateContext(context)
      return Buffer.concat([header(PLAINTEXT_MODE), Buffer.from(plaintext)])
    },
    async open(protectedContent, context) {
      validateContext(context)
      const envelope = parseEnvelope(protectedContent)
      if (envelope.mode !== PLAINTEXT_MODE) {
        throw new ProtectionError('PROTECTION_MODE_MISMATCH', 'Protected content mode is invalid')
      }
      return Buffer.from(envelope.payload)
    },
    dispose() {},
  }
}

export function createEncryptedProtector(masterKey: MasterKey): ContentProtector {
  const key = masterKey.copyBytes()

  return {
    mode: 'encrypted',
    async seal(plaintext, context) {
      const nonce = randomBytes(NONCE_LENGTH)
      const envelopeHeader = header(ENCRYPTED_MODE)
      const cipher = createCipheriv(ALGORITHM, key, nonce, {
        authTagLength: AUTHENTICATION_TAG_LENGTH,
      })
      cipher.setAAD(contextAad(context))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const authenticationTag = cipher.getAuthTag()
      return Buffer.concat([envelopeHeader, nonce, authenticationTag, ciphertext])
    },
    async open(protectedContent, context) {
      const envelope = parseEnvelope(protectedContent)
      if (
        envelope.mode !== ENCRYPTED_MODE ||
        envelope.payload.length < NONCE_LENGTH + AUTHENTICATION_TAG_LENGTH
      ) {
        throw new ProtectionAuthenticationError()
      }

      const nonce = envelope.payload.subarray(0, NONCE_LENGTH)
      const authenticationTag = envelope.payload.subarray(
        NONCE_LENGTH,
        NONCE_LENGTH + AUTHENTICATION_TAG_LENGTH,
      )
      const ciphertext = envelope.payload.subarray(NONCE_LENGTH + AUTHENTICATION_TAG_LENGTH)

      try {
        const decipher = createDecipheriv(ALGORITHM, key, nonce, {
          authTagLength: AUTHENTICATION_TAG_LENGTH,
        })
        decipher.setAAD(contextAad(context))
        decipher.setAuthTag(authenticationTag)
        return Buffer.concat([decipher.update(ciphertext), decipher.final()])
      } catch {
        throw new ProtectionAuthenticationError()
      }
    },
    dispose() {
      key.fill(0)
    },
  }
}

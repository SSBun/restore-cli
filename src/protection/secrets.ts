import { timingSafeEqual } from 'node:crypto'
import { ProtectionError } from './errors.js'

const SECRET_REDACTION = '[REDACTED]'

export class MasterKey {
  readonly #bytes: Buffer

  constructor(bytes: Uint8Array) {
    if (bytes.byteLength !== 32) {
      throw new ProtectionError('INVALID_MASTER_KEY', 'Master key has an invalid length')
    }
    this.#bytes = Buffer.from(bytes)
  }

  copyBytes(): Buffer {
    return Buffer.from(this.#bytes)
  }

  equals(other: MasterKey): boolean {
    return timingSafeEqual(this.#bytes, other.#bytes)
  }

  dispose(): void {
    this.#bytes.fill(0)
  }

  toJSON(): string {
    return SECRET_REDACTION
  }

  toString(): string {
    return SECRET_REDACTION
  }
}

export class RecoverySecret {
  readonly #bytes: Buffer

  constructor(bytes: Uint8Array) {
    if (bytes.byteLength !== 32) {
      throw new ProtectionError('INVALID_RECOVERY_SECRET', 'Recovery credential is invalid')
    }
    this.#bytes = Buffer.from(bytes)
  }

  copyBytes(): Buffer {
    return Buffer.from(this.#bytes)
  }

  dispose(): void {
    this.#bytes.fill(0)
  }

  toJSON(): string {
    return SECRET_REDACTION
  }

  toString(): string {
    return SECRET_REDACTION
  }
}

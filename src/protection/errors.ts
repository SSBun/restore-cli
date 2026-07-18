export class ProtectionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProtectionError'
    this.code = code
  }
}

export class ProtectionAuthenticationError extends ProtectionError {
  constructor() {
    super('AUTHENTICATION_FAILED', 'Repository credential or authenticated content is invalid')
    this.name = 'ProtectionAuthenticationError'
  }
}

export type RepositoryErrorCategory =
  | 'authentication'
  | 'configuration'
  | 'destination'
  | 'integrity'
  | 'lock'

export class RepositoryError extends Error {
  readonly category: RepositoryErrorCategory
  readonly code: string

  constructor(category: RepositoryErrorCategory, code: string, message: string) {
    super(message)
    this.name = 'RepositoryError'
    this.category = category
    this.code = code
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

import { RepositoryError } from './errors.js'
import type { RepositoryHandle } from './types.js'

const authorizedWriteHandles = new WeakSet<RepositoryHandle>()

export function authorizeRepositoryWrite(repository: RepositoryHandle): void {
  authorizedWriteHandles.add(repository)
}

export function closeRepositoryWrite(repository: RepositoryHandle): void {
  authorizedWriteHandles.delete(repository)
}

export function assertRepositoryWriteAuthorized(repository: RepositoryHandle): void {
  if (!authorizedWriteHandles.has(repository)) {
    throw new RepositoryError(
      'authentication',
      'WRITE_AUTHORIZATION_REQUIRED',
      'Repository write session is not authenticated or has been closed',
    )
  }
}

import { join, resolve } from 'node:path'
import { REPOSITORY_DIRECTORY_NAME, type RepositoryLayout } from './types.js'

export function getRepositoryPath(targetPath: string): string {
  return join(resolve(targetPath), REPOSITORY_DIRECTORY_NAME)
}

export function getRepositoryLayout(repositoryPath: string): RepositoryLayout {
  const root = resolve(repositoryPath)
  const keys = join(root, 'keys')
  const locks = join(root, 'locks')

  return {
    root,
    descriptor: join(root, 'repository.json'),
    keys,
    recoveryKey: join(keys, 'recovery.json'),
    keyCheck: join(keys, 'key-check.enc'),
    points: join(root, 'points'),
    locks,
    repositoryLock: join(locks, 'repository.lock'),
    operations: join(root, 'operations'),
  }
}

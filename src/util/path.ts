import { homedir } from 'node:os'
import { resolve } from 'node:path'

export const BACKUP_DIR_NAME = 'RestoreBackup'

export function expandPath(path: string): string {
  const home = process.env.HOME || homedir()
  if (path.startsWith('~/')) return resolve(home, path.slice(2))
  if (path === '~') return home
  return resolve(path)
}

export function getBackupRoot(destinationPath: string): string {
  return resolve(expandPath(destinationPath), BACKUP_DIR_NAME)
}

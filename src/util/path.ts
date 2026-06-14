import { homedir } from 'node:os'
import { resolve } from 'node:path'

export const BACKUP_DIR_NAME = 'RestoreBackup'

/// Expand `~/path` to an absolute path.
export function expandPath(p: string): string {
  const home = process.env.HOME || homedir()
  if (p.startsWith('~/')) return resolve(home, p.slice(2))
  if (p === '~') return home
  return resolve(p)
}

/// Snapshot paths omit the leading `/` (e.g. `Users/name/file.txt`).
export function toSnapshotRelative(absPath: string): string {
  const resolved = resolve(absPath)
  return resolved.startsWith('/') ? resolved.slice(1) : resolved
}

export function getBackupRoot(destinationPath: string): string {
  return resolve(expandPath(destinationPath), BACKUP_DIR_NAME)
}

/// Whether `relativePath` (snapshot layout) falls under an expanded source root.
export function isUnderRoot(relativePath: string, root: string): boolean {
  const rootRel = toSnapshotRelative(expandPath(root))
  return relativePath === rootRel || relativePath.startsWith(`${rootRel}/`)
}

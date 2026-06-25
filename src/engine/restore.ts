import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isUnderRoot } from '../util/path.js'
import { listCompleteSnapshots, snapshotNameToDate } from './snapshot.js'

/// Metadata for a single snapshot.
export interface SnapshotInfo {
  name: string
  path: string
  createdAt: Date
  fileCount: number
}

export interface RestoreFilePlan {
  sourcePath: string
  relativePath: string
  destinationPath: string
}

export interface RestoreOptions {
  toDir?: string
}

/// Returns all snapshots under `destDir` sorted newest-first.
export async function getSnapshotInfo(destDir: string): Promise<SnapshotInfo[]> {
  const items = await listCompleteSnapshots(destDir)
  const snapshots: SnapshotInfo[] = []

  for (const name of items) {
    const fullPath = resolve(destDir, name)
    try {
      const files = await countFiles(fullPath)
      snapshots.push({
        name,
        path: fullPath,
        createdAt: snapshotNameToDate(name),
        fileCount: files,
      })
    } catch {
      // skip invalid / inaccessible dirs
    }
  }

  return snapshots.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

async function countFiles(dir: string): Promise<number> {
  let count = 0
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      count += await countFiles(full)
    } else {
      count++
    }
  }
  return count
}

/// Recursively walk files in a directory, returning absolute paths.
async function walkFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(full)))
    } else {
      results.push(full)
    }
  }
  return results
}

/// Restores files from `snapshotDir` back to their original locations.
///
/// The snapshot stores files using their absolute path minus the leading `/`,
/// so `snapshotDir/Users/name/file.txt` restores to `/Users/name/file.txt`.
/// Only files whose paths fall under one of the `restoreRoots` are restored.
/// Roots may use `~/` prefixes; they are expanded before matching.
/// When `toDir` is provided, files are restored under that directory while
/// preserving the snapshot-relative path.
/// - Returns: The number of files successfully restored.
export async function planRestoreFromSnapshot(
  snapshotDir: string,
  restoreRoots: string[],
  options: RestoreOptions = {},
): Promise<RestoreFilePlan[]> {
  const planned: RestoreFilePlan[] = []
  const files = await walkFiles(snapshotDir)

  for (const fullPath of files) {
    // Strip the snapshotDir prefix to get the relative path (e.g. "Users/name/file.txt")
    const relativePath = fullPath.startsWith(snapshotDir)
      ? fullPath.slice(snapshotDir.length + 1)
      : fullPath

    const matched = restoreRoots.some((root) => isUnderRoot(relativePath, root))
    if (!matched) continue

    planned.push({
      sourcePath: fullPath,
      relativePath,
      destinationPath: options.toDir
        ? resolve(options.toDir, relativePath)
        : resolve('/', relativePath),
    })
  }

  return planned
}

export async function restoreFromSnapshot(
  snapshotDir: string,
  restoreRoots: string[],
  options: RestoreOptions = {},
): Promise<{ restored: number; planned: RestoreFilePlan[] }> {
  let restored = 0
  const planned = await planRestoreFromSnapshot(snapshotDir, restoreRoots, options)

  for (const file of planned) {
    await mkdir(dirname(file.destinationPath), { recursive: true })
    await copyFile(file.sourcePath, file.destinationPath)
    restored++
  }

  return { restored, planned }
}

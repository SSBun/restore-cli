import { statSync } from 'node:fs'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { listSubdirs } from '../util/fs.js'

/// Metadata for a single snapshot.
export interface SnapshotInfo {
  name: string
  path: string
  createdAt: Date
  fileCount: number
}

/// Returns all snapshots under `destDir` sorted newest-first.
export async function getSnapshotInfo(destDir: string): Promise<SnapshotInfo[]> {
  const items = await listSubdirs(destDir)
  const snapshots: SnapshotInfo[] = []

  for (const name of items) {
    const fullPath = resolve(destDir, name)
    try {
      const s = statSync(fullPath)
      const files = await countFiles(fullPath)
      snapshots.push({
        name,
        path: fullPath,
        createdAt: s.birthtime || s.mtime,
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
/// - Returns: The number of files successfully restored.
export async function restoreFromSnapshot(
  snapshotDir: string,
  restoreRoots: string[],
): Promise<{ restored: number }> {
  let restored = 0
  const files = await walkFiles(snapshotDir)

  for (const fullPath of files) {
    // Strip the snapshotDir prefix to get the relative path (e.g. "Users/name/file.txt")
    const relativePath = fullPath.startsWith(snapshotDir)
      ? fullPath.slice(snapshotDir.length + 1)
      : fullPath

    // Only restore files that belong to one of the known source roots
    const matchedRoot = restoreRoots.find((root) => relativePath.startsWith(root.slice(1)))
    if (!matchedRoot) continue

    const destPath = resolve('/', relativePath)
    await mkdir(resolve(destPath, '..'), { recursive: true })
    await copyFile(fullPath, destPath)
    restored++
  }

  return { restored }
}

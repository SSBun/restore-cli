import { stat, utimes } from 'node:fs/promises'
import { resolve } from 'node:path'
import { copyWithChecksum, ensureDir, hardlinkCopy, listSubdirs } from '../util/fs.js'
import { debug, info } from '../util/log.js'
import { diffWithLastSnapshot } from './diff.js'

function getTimestamp(): string {
  return new Date().toISOString().replace(/:/g, '-').replace('Z', '')
}

/// Returns the path to the most recent snapshot directory, or `null` if none exist.
export async function getLatestSnapshotDir(destDir: string): Promise<string | null> {
  try {
    const dirs = await listSubdirs(destDir)
    if (dirs.length === 0) return null
    dirs.sort()
    return resolve(destDir, dirs[dirs.length - 1])
  } catch {
    return null
  }
}

/// Creates a new snapshot under `destDir` by diffing `sources` against the latest snapshot.
///
/// Unchanged files are hardlinked from the previous snapshot (Time Machine style);
/// new or modified files are copied with checksum verification.
/// - Returns: The timestamp string used as the snapshot directory name.
export async function createSnapshot(sources: string[], destDir: string): Promise<string> {
  const timestamp = getTimestamp()
  const snapshotPath = resolve(destDir, timestamp)

  const latestSnapshot = await getLatestSnapshotDir(destDir)
  const diffs = await diffWithLastSnapshot(sources, latestSnapshot)

  await ensureDir(snapshotPath)

  let copied = 0
  let linked = 0

  for (const diff of diffs) {
    const relPath = diff.path.startsWith('/') ? diff.path.slice(1) : diff.path
    const destFile = resolve(snapshotPath, relPath)

    if (diff.type === 'unchanged' && latestSnapshot) {
      // Hardlink from the latest snapshot
      const srcInLatest = resolve(latestSnapshot, relPath)
      await ensureDir(resolve(destFile, '..'))
      await hardlinkCopy(srcInLatest, destFile)
      linked++
      debug(`link: ${relPath}`)
    } else {
      // Copy (new or modified) — preserve source mtime so next diff detects as unchanged
      await ensureDir(resolve(destFile, '..'))
      await copyWithChecksum(diff.path, destFile)
      const srcStat = await stat(diff.path)
      await utimes(destFile, srcStat.atime, srcStat.mtime)
      copied++
      debug(`copy: ${relPath}`)
    }
  }

  info(`Snapshot ${timestamp}: ${linked} linked, ${copied} copied`)
  return timestamp
}

import { rename, stat, utimes, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { copyWithChecksum, ensureDir, hardlinkCopy, listSubdirs } from '../util/fs.js'
import { debug, info } from '../util/log.js'
import { diffWithLastSnapshot } from './diff.js'

const SNAPSHOT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d+$/

function getTimestamp(): string {
  return new Date().toISOString().replace(/:/g, '-').replace('Z', '')
}

export function snapshotTimestamp(): string {
  return getTimestamp()
}

export function isValidSnapshotName(name: string): boolean {
  return SNAPSHOT_REGEX.test(name)
}

export async function listCompleteSnapshots(destDir: string): Promise<string[]> {
  try {
    const dirs = await listSubdirs(destDir)
    return dirs.filter(isValidSnapshotName).sort()
  } catch {
    return []
  }
}

export function snapshotNameToDate(name: string): Date {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d+)$/.exec(name)
  if (!match) return new Date(0)
  return new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
}

/// Returns the path to the most recent snapshot directory, or `null` if none exist.
export async function getLatestSnapshotDir(destDir: string): Promise<string | null> {
  const snapshots = await listCompleteSnapshots(destDir)
  if (snapshots.length === 0) return null
  return resolve(destDir, snapshots[snapshots.length - 1])
}

/// Ensure `backupRoot` dir exists and has a `.restore-marker` file.
export async function ensureBackupRoot(backupRoot: string): Promise<void> {
  await ensureDir(backupRoot)
  const markerPath = resolve(backupRoot, '.restore-marker')
  await writeFile(markerPath, 'restore-backup-directory\n', 'utf-8')
}

export type SnapshotSyncAction = 'link' | 'copy'

export interface SnapshotSyncProgress {
  action: SnapshotSyncAction
  path: string
  current: number
  total: number
  linked: number
  copied: number
}

/// Apply file diffs into an open snapshot directory.
export async function applyDiffsToSnapshot(
  snapshotPath: string,
  diffs: Awaited<ReturnType<typeof diffWithLastSnapshot>>,
  latestSnapshot: string | null,
  progress?: { onFileStart?: (event: SnapshotSyncProgress) => void },
): Promise<{ linked: number; copied: number }> {
  let copied = 0
  let linked = 0

  for (let i = 0; i < diffs.length; i++) {
    const diff = diffs[i]
    const relPath = diff.path.startsWith('/') ? diff.path.slice(1) : diff.path
    const destFile = resolve(snapshotPath, relPath)

    if (diff.type === 'unchanged' && latestSnapshot) {
      progress?.onFileStart?.({
        action: 'link',
        path: diff.path,
        current: i + 1,
        total: diffs.length,
        linked,
        copied,
      })
      const srcInLatest = resolve(latestSnapshot, relPath)
      await ensureDir(resolve(destFile, '..'))
      await hardlinkCopy(srcInLatest, destFile)
      linked++
      debug(`link: ${relPath}`)
    } else {
      progress?.onFileStart?.({
        action: 'copy',
        path: diff.path,
        current: i + 1,
        total: diffs.length,
        linked,
        copied,
      })
      await ensureDir(resolve(destFile, '..'))
      await copyWithChecksum(diff.path, destFile)
      const srcStat = await stat(diff.path)
      await utimes(destFile, srcStat.atime, srcStat.mtime)
      copied++
      debug(`copy: ${relPath}`)
    }
  }

  return { linked, copied }
}

/// Creates a new snapshot under `destDir` by diffing `sources` against the latest snapshot.
///
/// Unchanged files are hardlinked from the previous snapshot (Time Machine style);
/// new or modified files are copied with checksum verification.
/// - Returns: The timestamp string used as the snapshot directory name.
export async function createSnapshot(sources: string[], destDir: string): Promise<string> {
  const timestamp = getTimestamp()
  const snapshotPath = resolve(destDir, timestamp)
  const pendingSnapshotPath = resolve(destDir, `${timestamp}.in-progress`)

  const latestSnapshot = await getLatestSnapshotDir(destDir)
  const diffs = await diffWithLastSnapshot(sources, latestSnapshot)

  await ensureDir(pendingSnapshotPath)

  const { linked, copied } = await applyDiffsToSnapshot(pendingSnapshotPath, diffs, latestSnapshot)
  await rename(pendingSnapshotPath, snapshotPath)

  info(`Snapshot ${timestamp}: ${linked} linked, ${copied} copied`)
  return timestamp
}

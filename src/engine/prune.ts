import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { debug } from '../util/log.js'
import { listCompleteSnapshots } from './snapshot.js'

export interface PruneResult {
  removed: number
  failed: string[]
}

/// Returns complete snapshot directory names under `destDir`, sorted oldest-first by name time.
export async function listSnapshots(destDir: string): Promise<string[]> {
  return listCompleteSnapshots(destDir)
}

/// Removes the oldest snapshots exceeding `maxCount`, reporting failures without throwing.
export async function pruneSnapshotsDetailed(
  destDir: string,
  maxCount: number,
): Promise<PruneResult> {
  const snapshots = await listSnapshots(destDir)
  if (snapshots.length <= maxCount) return { removed: 0, failed: [] }

  const toRemove = snapshots.slice(0, snapshots.length - maxCount)
  let removed = 0
  const failed: string[] = []
  for (const name of toRemove) {
    const fullPath = resolve(destDir, name)
    try {
      await rm(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      removed++
      debug(`Pruned old snapshot: ${name}`)
    } catch {
      failed.push(name)
      debug(`Failed to prune old snapshot: ${name}`)
    }
  }
  return { removed, failed }
}

/// Removes the oldest snapshots exceeding `maxCount`.
/// Returns the number of snapshots removed.
export async function pruneSnapshots(destDir: string, maxCount: number): Promise<number> {
  return (await pruneSnapshotsDetailed(destDir, maxCount)).removed
}

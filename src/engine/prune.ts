import { rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { listSubdirs } from '../util/fs.js'
import { debug } from '../util/log.js'
import { isValidSnapshotName } from './snapshot.js'

/// Returns snapshot directory names under `destDir`, sorted oldest-first by birthtime.
/// Only directories matching the snapshot timestamp format are included.
export async function listSnapshots(destDir: string): Promise<string[]> {
  try {
    const dirs = await listSubdirs(destDir)
    const snapshots = dirs.filter(isValidSnapshotName)
    const withTime = await Promise.all(
      snapshots.map(async (name) => {
        try {
          const s = await stat(resolve(destDir, name))
          return { name, time: s.birthtimeMs || s.mtimeMs }
        } catch {
          return { name, time: 0 }
        }
      }),
    )
    return withTime.sort((a, b) => a.time - b.time).map((d) => d.name)
  } catch {
    return []
  }
}

/// Removes the oldest snapshots exceeding `maxCount`.
/// Returns the number of snapshots removed.
export async function pruneSnapshots(destDir: string, maxCount: number): Promise<number> {
  const snapshots = await listSnapshots(destDir)
  if (snapshots.length <= maxCount) return 0

  const toRemove = snapshots.slice(0, snapshots.length - maxCount)
  for (const name of toRemove) {
    const fullPath = resolve(destDir, name)
    await rm(fullPath, { recursive: true, force: true })
    debug(`Pruned old snapshot: ${name}`)
  }
  return toRemove.length
}

import { rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { listSubdirs } from '../util/fs.js'
import { info } from '../util/log.js'

/// Returns snapshot directory names under `destDir`, sorted oldest-first by birthtime.
export async function listSnapshots(destDir: string): Promise<string[]> {
  try {
    const dirs = await listSubdirs(destDir)
    const withTime = await Promise.all(
      dirs.map(async (name) => {
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
export async function pruneSnapshots(destDir: string, maxCount: number): Promise<void> {
  const snapshots = await listSnapshots(destDir)
  if (snapshots.length <= maxCount) return

  const toRemove = snapshots.slice(0, snapshots.length - maxCount)
  for (const name of toRemove) {
    const fullPath = resolve(destDir, name)
    await rm(fullPath, { recursive: true, force: true })
    info(`Pruned old snapshot: ${name}`)
  }
}

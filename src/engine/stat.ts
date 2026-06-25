import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getSnapshotInfo } from './restore.js'

export interface DirectoryUsage {
  bytes: number
  files: number
}

export interface BackupStat {
  backupRoot: string
  snapshotCount: number
  lastBackupName: string | null
  lastBackupAt: Date | null
  latestSnapshotBytes: number
  latestSnapshotFiles: number
  totalBackupBytes: number
  totalBackupFiles: number
}

export async function getDirectoryUsage(dir: string): Promise<DirectoryUsage> {
  let bytes = 0
  let files = 0

  async function walk(current: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = resolve(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }

      try {
        const s = await stat(full)
        bytes += s.size
        files++
      } catch {
        // skip inaccessible or deleted files
      }
    }
  }

  await walk(dir)
  return { bytes, files }
}

export async function getBackupStat(backupRoot: string): Promise<BackupStat> {
  const snapshots = await getSnapshotInfo(backupRoot)
  const latest = snapshots[0] ?? null
  const totalUsage = await getDirectoryUsage(backupRoot)
  const latestUsage = latest ? await getDirectoryUsage(latest.path) : { bytes: 0, files: 0 }

  return {
    backupRoot,
    snapshotCount: snapshots.length,
    lastBackupName: latest?.name ?? null,
    lastBackupAt: latest?.createdAt ?? null,
    latestSnapshotBytes: latestUsage.bytes,
    latestSnapshotFiles: latest?.fileCount ?? latestUsage.files,
    totalBackupBytes: totalUsage.bytes,
    totalBackupFiles: totalUsage.files,
  }
}

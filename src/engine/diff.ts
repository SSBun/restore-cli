import { readdir, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

export interface FileDiff {
  path: string // absolute path within source
  type: 'added' | 'modified' | 'unchanged'
}

/// Recursively collect all files in a directory.
export async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  async function walk(current: string) {
    try {
      const entries = await readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        const full = resolve(current, entry.name)
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) await walk(full)
        } else {
          files.push(full)
        }
      }
    } catch {
      // skip inaccessible or deleted directories
    }
  }
  await walk(dir)
  return files
}

/// Compare source files vs the latest snapshot using size + mtime (fast path).
///
/// - Parameter sources: List of source file or directory paths to back up.
/// - Parameter snapshotDir: Path to the latest snapshot directory, or `null` if none exists.
/// - Returns: An array of `FileDiff` entries describing each file's state.
export async function diffWithLastSnapshot(
  sources: string[],
  snapshotDir: string | null,
): Promise<FileDiff[]> {
  // Gather all source file paths
  const sourceFiles: string[] = []
  for (const src of sources) {
    try {
      const s = await stat(src)
      if (s.isDirectory()) {
        const children = await collectFiles(src)
        sourceFiles.push(...children)
      } else {
        sourceFiles.push(src)
      }
    } catch {}
  }

  if (!snapshotDir) {
    // No previous snapshot — everything is "added"
    return sourceFiles.map((f) => ({ path: f, type: 'added' as const }))
  }

  const result: FileDiff[] = []
  for (const file of sourceFiles) {
    const snapshotPath = resolve(snapshotDir, relative('/', file))
    try {
      const snapStat = await stat(snapshotPath)
      const srcStat = await stat(file)
      if (
        srcStat.size !== snapStat.size ||
        Math.round(srcStat.mtimeMs) !== Math.round(snapStat.mtimeMs)
      ) {
        result.push({ path: file, type: 'modified' })
      } else {
        result.push({ path: file, type: 'unchanged' })
      }
    } catch {
      result.push({ path: file, type: 'added' })
    }
  }

  return result
}

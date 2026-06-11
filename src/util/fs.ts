import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileHash } from './hash.js'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function hardlinkCopy(src: string, dest: string): Promise<void> {
  try {
    await link(src, dest)
  } catch {
    // Fallback: copy if hardlink fails (e.g. cross-device)
    await copyFile(src, dest)
  }
}

export async function copyWithChecksum(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest)

  // Verify checksum
  const srcHash = await fileHash(src)
  const destHash = await fileHash(dest)

  if (srcHash !== destHash) {
    throw new Error(`Checksum mismatch after copy: ${src} -> ${dest}`)
  }
}

export async function listSubdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  return dirs.sort()
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

export async function getFileSize(filePath: string): Promise<number> {
  const s = await stat(filePath)
  return s.size
}

export async function getMtime(filePath: string): Promise<Date> {
  const s = await stat(filePath)
  return s.mtime
}

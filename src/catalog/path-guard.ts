import { constants, closeSync, fstatSync, lstatSync, openSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { type BigStat, CatalogCaptureError } from './stable-read.js'

interface HeldDirectory {
  path: string
  descriptor: number
  device: bigint
  inode: bigint
}

function directoryChain(path: string): string[] {
  const directories = [resolve('/')]
  let current = resolve('/')
  for (const component of resolve(path).split(sep).filter(Boolean)) {
    current = join(current, component)
    directories.push(current)
  }
  return directories
}

export class CapturePathGuard {
  readonly #directories = new Map<string, HeldDirectory>()

  static async create(targetPath: string, finalIsDirectory: boolean): Promise<CapturePathGuard> {
    const guard = new CapturePathGuard()
    try {
      const parent = finalIsDirectory ? targetPath : dirname(targetPath)
      for (const path of directoryChain(parent)) await guard.holdDirectory(path)
      return guard
    } catch (error) {
      await guard.close()
      throw error
    }
  }

  async holdDirectory(path: string): Promise<void> {
    const canonical = resolve(path)
    if (this.#directories.has(canonical)) return
    let descriptor: number
    try {
      descriptor = openSync(
        canonical,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      )
    } catch {
      throw new CatalogCaptureError(
        'SOURCE_SCOPE_CHANGED',
        'A source directory could not be held without following links',
      )
    }
    try {
      const held = fstatSync(descriptor, { bigint: true }) as BigStat
      const current = lstatSync(canonical, { bigint: true }) as BigStat
      if (
        !held.isDirectory() ||
        !current.isDirectory() ||
        held.dev !== current.dev ||
        held.ino !== current.ino
      ) {
        throw new CatalogCaptureError(
          'SOURCE_SCOPE_CHANGED',
          'A source directory changed while its identity was held',
        )
      }
      this.#directories.set(canonical, {
        path: canonical,
        descriptor,
        device: held.dev,
        inode: held.ino,
      })
    } catch (error) {
      closeSync(descriptor)
      throw error
    }
  }

  async assertStable(): Promise<void> {
    for (const directory of this.#directories.values()) {
      let held: BigStat
      let current: BigStat
      try {
        held = fstatSync(directory.descriptor, { bigint: true }) as BigStat
        current = lstatSync(directory.path, { bigint: true }) as BigStat
      } catch {
        throw new CatalogCaptureError(
          'SOURCE_SCOPE_CHANGED',
          'A held source directory disappeared during capture',
        )
      }
      if (
        !held.isDirectory() ||
        !current.isDirectory() ||
        held.dev !== directory.device ||
        held.ino !== directory.inode ||
        current.dev !== directory.device ||
        current.ino !== directory.inode
      ) {
        throw new CatalogCaptureError(
          'SOURCE_SCOPE_CHANGED',
          'A source parent directory was replaced during capture',
        )
      }
    }
  }

  identity(path: string): { device: bigint; inode: bigint } {
    const directory = this.#directories.get(resolve(path))
    if (!directory) {
      throw new CatalogCaptureError(
        'SOURCE_SCOPE_CHANGED',
        'Source metadata parent identity was not held',
      )
    }
    return { device: directory.device, inode: directory.inode }
  }

  async close(): Promise<void> {
    const directories = [...this.#directories.values()].reverse()
    this.#directories.clear()
    for (const directory of directories) {
      try {
        closeSync(directory.descriptor)
      } catch {
        // Closing is best-effort after capture has already finished.
      }
    }
  }
}

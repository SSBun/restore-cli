import { createHash } from 'node:crypto'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CapturePathGuard } from './path-guard.js'
import {
  type BigStat,
  type CaptureOptions,
  CatalogCaptureError,
  metadataMatches,
  nativeMetadata,
  portableMetadata,
  readStableRegularFile,
} from './stable-read.js'
import type { CapturedEntry, ResolvedSource } from './types.js'

function entryId(source: ResolvedSource, relativePath: string): string {
  return `${source.id}:${relativePath}`
}

function captureIdentity(metadata: BigStat): NonNullable<CapturedEntry['identity']> {
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    changedAtNs: metadata.ctimeNs.toString(),
    hardlinkCount: metadata.nlink.toString(),
  }
}

async function guardedLstat(path: string, guard: CapturePathGuard): Promise<BigStat> {
  await guard.assertStable()
  const metadata = (await lstat(path, { bigint: true })) as BigStat
  await guard.assertStable()
  return metadata
}

async function captureFile(
  source: ResolvedSource,
  path: string,
  relativePath: string,
  options: CaptureOptions,
  guard: CapturePathGuard,
  expected: BigStat,
): Promise<CapturedEntry> {
  const stable = await readStableRegularFile(path, options, guard)
  try {
    if (!metadataMatches(expected, stable.metadata)) {
      throw new CatalogCaptureError('SOURCE_UNSTABLE', 'Source identity changed before file open')
    }
    const native = await nativeMetadata(path, options, guard)
    const after = await guardedLstat(path, guard)
    if (!after.isFile() || !metadataMatches(stable.metadata, after)) {
      throw new CatalogCaptureError('SOURCE_UNSTABLE', 'Source changed while metadata was captured')
    }
    return {
      id: entryId(source, relativePath),
      sourceId: source.id,
      relativePath,
      type: 'file',
      metadata: portableMetadata(after, native.metadata),
      ...(native.issues.length > 0 ? { fidelityIssues: native.issues } : {}),
      contentHash: createHash('sha256').update(stable.content).digest('hex'),
      content: stable.content,
      identity: captureIdentity(after),
    }
  } catch (error) {
    stable.content.fill(0)
    options.memoryBudget?.release(stable.content.length)
    throw error
  }
}

async function captureSymlink(
  source: ResolvedSource,
  path: string,
  relativePath: string,
  options: CaptureOptions,
  guard: CapturePathGuard,
  expected?: BigStat,
): Promise<CapturedEntry> {
  const before = await guardedLstat(path, guard)
  if (!before.isSymbolicLink()) {
    throw new CatalogCaptureError('SOURCE_TYPE_CHANGED', 'Source is no longer a symbolic link')
  }
  if (expected && !metadataMatches(expected, before)) {
    throw new CatalogCaptureError('SOURCE_UNSTABLE', 'Symbolic link identity changed before read')
  }
  await guard.assertStable()
  const target = await readlink(path)
  await guard.assertStable()
  const native = await nativeMetadata(path, options, guard, true)
  const after = await guardedLstat(path, guard)
  if (!after.isSymbolicLink() || !metadataMatches(before, after)) {
    throw new CatalogCaptureError('SOURCE_UNSTABLE', 'Symbolic link changed during capture')
  }
  return {
    id: entryId(source, relativePath),
    sourceId: source.id,
    relativePath,
    type: 'symlink',
    metadata: portableMetadata(after, native.metadata),
    ...(native.issues.length > 0 ? { fidelityIssues: native.issues } : {}),
    linkTarget: target,
    identity: captureIdentity(after),
  }
}

async function readDirectoryNames(path: string, guard: CapturePathGuard): Promise<string[]> {
  try {
    await guard.assertStable()
    const names = (await readdir(path)).sort()
    await guard.assertStable()
    return names
  } catch (error) {
    if (error instanceof CatalogCaptureError) throw error
    throw new CatalogCaptureError('SOURCE_UNREADABLE', 'Source directory cannot be read')
  }
}

async function captureDirectory(
  source: ResolvedSource,
  path: string,
  relativePath: string,
  options: CaptureOptions,
  guard: CapturePathGuard,
): Promise<CapturedEntry[]> {
  const queue: Array<{ path: string; relativePath: string }> = [{ path, relativePath }]
  const directoryChecks: Array<{ path: string; metadata: BigStat }> = []
  const captured: CapturedEntry[] = []

  try {
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
      const directory = queue[queueIndex]
      await guard.holdDirectory(directory.path)
      const before = await guardedLstat(directory.path, guard)
      if (!before.isDirectory()) {
        throw new CatalogCaptureError('SOURCE_TYPE_CHANGED', 'Source is no longer a directory')
      }
      directoryChecks.push({ path: directory.path, metadata: before })
      const native = await nativeMetadata(directory.path, options, guard)
      captured.push({
        id: entryId(source, directory.relativePath),
        sourceId: source.id,
        relativePath: directory.relativePath,
        type: 'directory',
        metadata: portableMetadata(before, native.metadata),
        ...(native.issues.length > 0 ? { fidelityIssues: native.issues } : {}),
        identity: captureIdentity(before),
      })

      for (const name of await readDirectoryNames(directory.path, guard)) {
        const child = resolve(directory.path, name)
        const childRelative =
          directory.relativePath === '.' ? name : `${directory.relativePath}/${name}`
        let childMetadata: BigStat
        try {
          childMetadata = await guardedLstat(child, guard)
        } catch (error) {
          if (error instanceof CatalogCaptureError) throw error
          throw new CatalogCaptureError('SOURCE_UNSTABLE', 'Directory entry changed during capture')
        }
        if (childMetadata.isSymbolicLink()) {
          captured.push(
            await captureSymlink(source, child, childRelative, options, guard, childMetadata),
          )
        } else if (childMetadata.isFile()) {
          captured.push(
            await captureFile(source, child, childRelative, options, guard, childMetadata),
          )
        } else if (childMetadata.isDirectory()) {
          queue.push({ path: child, relativePath: childRelative })
        } else {
          throw new CatalogCaptureError(
            'UNSUPPORTED_SOURCE_TYPE',
            'Special files are outside the supported capture contract',
          )
        }
      }
    }

    for (const directory of directoryChecks) {
      const after = await guardedLstat(directory.path, guard)
      if (!after.isDirectory() || !metadataMatches(directory.metadata, after)) {
        throw new CatalogCaptureError('SOURCE_UNSTABLE', 'Source directory changed during capture')
      }
    }
  } catch (error) {
    wipeEntries(captured, options)
    throw error
  }
  if (source.includeEmptyDirectories) return captured
  const nonDirectories = captured.filter((entry) => entry.type !== 'directory')
  // ponytail: O(directories × entries); add a prefix index if config trees become large.
  return captured.filter(
    (entry) =>
      entry.type !== 'directory' ||
      entry.relativePath === '.' ||
      nonDirectories.some((child) => child.relativePath.startsWith(`${entry.relativePath}/`)),
  )
}

function actualEntryType(root: BigStat): 'file' | 'directory' | 'symlink' | 'special' {
  if (root.isSymbolicLink()) return 'symlink'
  if (root.isFile()) return 'file'
  if (root.isDirectory()) return 'directory'
  return 'special'
}

export async function captureSourceOnce(
  source: ResolvedSource,
  options: CaptureOptions,
): Promise<CapturedEntry[]> {
  let initial: BigStat
  try {
    initial = (await lstat(source.path, { bigint: true })) as BigStat
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CatalogCaptureError('SOURCE_MISSING', 'Declared source is missing')
    }
    throw new CatalogCaptureError('SOURCE_UNREADABLE', 'Declared source cannot be inspected')
  }
  const guard = await CapturePathGuard.create(source.path, initial.isDirectory())
  try {
    const root = await guardedLstat(source.path, guard)
    if (!metadataMatches(initial, root)) {
      throw new CatalogCaptureError(
        'SOURCE_SCOPE_CHANGED',
        'Source identity changed before capture',
      )
    }
    const actualType = actualEntryType(root)
    if (source.expectedType !== 'any' && source.expectedType !== actualType) {
      throw new CatalogCaptureError(
        'SOURCE_TYPE_CHANGED',
        'Source no longer matches its declared entry type',
      )
    }
    if (root.isSymbolicLink()) {
      return [await captureSymlink(source, source.path, '.', options, guard, root)]
    }
    if (root.isFile()) return [await captureFile(source, source.path, '.', options, guard, root)]
    if (root.isDirectory()) {
      return await captureDirectory(source, source.path, '.', options, guard)
    }
    throw new CatalogCaptureError(
      'UNSUPPORTED_SOURCE_TYPE',
      'Special files are outside the supported capture contract',
    )
  } finally {
    await guard.close()
  }
}

export function wipeEntries(entries: CapturedEntry[], options: CaptureOptions = {}): void {
  for (const entry of entries) {
    if (!entry.content) continue
    options.memoryBudget?.release(entry.content.length)
    entry.content.fill(0)
    entry.content = undefined
  }
}

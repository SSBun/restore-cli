import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { platform } from 'node:os'
import { basename, dirname } from 'node:path'
import { promisify } from 'node:util'
import type { CapturePathGuard } from './path-guard.js'
import type { CapturedMetadata, CapturedXattr } from './types.js'

const execFileAsync = promisify(execFile)
const DEFAULT_ATTEMPTS = 3
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_METADATA_OUTPUT_BYTES = 1024 * 1024
const HEX_BYTES_PATTERN = /^(?:[0-9a-fA-F]{2})*$/
const DIRECTORY_BOUND_METADATA_WORKER = String.raw`
const childProcess = require('node:child_process')
const fs = require('node:fs')
const [executable, expectedDevice, expectedInode, encodedArgs] = process.argv.slice(1)
let directory
try {
  directory = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY)
  const held = fs.fstatSync(directory, { bigint: true })
  if (!held.isDirectory() || held.dev !== BigInt(expectedDevice) || held.ino !== BigInt(expectedInode)) {
    throw new Error('cwd identity mismatch')
  }
  const args = JSON.parse(Buffer.from(encodedArgs, 'base64').toString('utf8'))
  const output = childProcess.execFileSync(executable, args, {
    encoding: 'buffer',
    timeout: 3000,
    maxBuffer: ${MAX_METADATA_OUTPUT_BYTES},
    windowsHide: true,
  })
  process.stdout.write(output)
} catch {
  process.exitCode = 1
} finally {
  if (directory !== undefined) {
    try { fs.closeSync(directory) } catch {}
  }
}
`

export type BigStat = BigIntStats
export type MetadataCommandRunner = (executable: string, args: string[]) => Promise<Buffer>

export interface CaptureOptions {
  attempts?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  metadataCommandRunner?: MetadataCommandRunner
  onBeforeFileOpen?: (path: string, attempt: number) => void | Promise<void>
  onReadAttempt?: (path: string, attempt: number) => void | Promise<void>
  onBeforeMetadataCommand?: (path: string) => void | Promise<void>
  onAfterMetadataCommand?: (path: string) => void | Promise<void>
  onSourceCaptured?: (sourceId: string) => void | Promise<void>
  /** Internal per-capture shared reservation; callers should leave this unset. */
  memoryBudget?: CaptureMemoryBudget
}

export interface CaptureMemoryBudget {
  readonly maximum: number
  used: number
  reserve(bytes: number): void
  release(bytes: number): void
}

export interface MetadataFidelityIssue {
  code: 'METADATA_XATTR_UNREADABLE' | 'METADATA_FLAGS_UNREADABLE'
  message: string
}

export interface NativeMetadataResult {
  metadata: Pick<CapturedMetadata, 'xattrs' | 'flags'>
  issues: MetadataFidelityIssue[]
}

export class CatalogCaptureError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CatalogCaptureError'
    this.code = code
  }
}

export function validateAttempts(attempts = DEFAULT_ATTEMPTS): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new CatalogCaptureError('INVALID_CAPTURE_LIMIT', 'Capture retry limit is invalid')
  }
  return attempts
}

export function createCaptureMemoryBudget(maximum: number): CaptureMemoryBudget {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new CatalogCaptureError('INVALID_CAPTURE_LIMIT', 'Total capture size limit is invalid')
  }
  return {
    maximum,
    used: 0,
    reserve(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || this.used + bytes > this.maximum) {
        throw new CatalogCaptureError(
          'CAPTURE_TOO_LARGE',
          'Capture exceeds the bounded in-memory catalog size',
        )
      }
      this.used += bytes
    },
    release(bytes) {
      this.used = Math.max(0, this.used - bytes)
    },
  }
}

export function metadataMatches(left: BigStat, right: BigStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function safeSize(size: bigint, maximum: number): number {
  if (size < 0n || size > BigInt(maximum) || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CatalogCaptureError(
      'SOURCE_FILE_TOO_LARGE',
      'Source file exceeds the bounded capture size',
    )
  }
  return Number(size)
}

async function defaultMetadataCommandRunner(executable: string, args: string[]): Promise<Buffer> {
  const result = await execFileAsync(executable, args, {
    encoding: 'buffer',
    timeout: 3000,
    maxBuffer: MAX_METADATA_OUTPUT_BYTES,
    windowsHide: true,
  })
  return Buffer.from(result.stdout)
}

async function directoryBoundMetadataCommand(
  executable: string,
  args: string[],
  path: string,
  guard: CapturePathGuard,
): Promise<Buffer> {
  const parent = dirname(path)
  const identity = guard.identity(parent)
  const relativeArgs = args.map((argument) => (argument === path ? basename(path) : argument))
  const encodedArgs = Buffer.from(JSON.stringify(relativeArgs)).toString('base64')
  const result = await execFileAsync(
    process.execPath,
    [
      '-e',
      DIRECTORY_BOUND_METADATA_WORKER,
      executable,
      identity.device.toString(),
      identity.inode.toString(),
      encodedArgs,
    ],
    {
      cwd: parent,
      encoding: 'buffer',
      timeout: 5000,
      maxBuffer: MAX_METADATA_OUTPUT_BYTES,
      windowsHide: true,
    },
  )
  return Buffer.from(result.stdout)
}

export async function nativeMetadata(
  path: string,
  options: CaptureOptions,
  guard?: CapturePathGuard,
  symbolicLink = false,
): Promise<NativeMetadataResult> {
  if (platform() !== 'darwin') return { metadata: {}, issues: [] }

  const metadata: Pick<CapturedMetadata, 'xattrs' | 'flags'> = {}
  const issues: MetadataFidelityIssue[] = []
  const runner: MetadataCommandRunner = options.metadataCommandRunner
    ? options.metadataCommandRunner
    : guard
      ? (executable, args) => directoryBoundMetadataCommand(executable, args, path, guard)
      : defaultMetadataCommandRunner
  const run = async (executable: string, args: string[]): Promise<Buffer> => {
    await guard?.assertStable()
    await options.onBeforeMetadataCommand?.(path)
    let output: Buffer
    try {
      output = await runner(executable, args)
    } finally {
      await options.onAfterMetadataCommand?.(path)
    }
    await guard?.assertStable()
    return output
  }
  try {
    const names = (await run('/usr/bin/xattr', [...(symbolicLink ? ['-s'] : []), '--', path]))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .sort()
    const xattrs: CapturedXattr[] = []
    let total = 0
    for (const name of names) {
      const value = (
        await run('/usr/bin/xattr', ['-p', '-x', ...(symbolicLink ? ['-s'] : []), name, '--', path])
      )
        .toString('ascii')
        .replace(/\s/g, '')
      if (!HEX_BYTES_PATTERN.test(value)) throw new Error('invalid xattr output')
      total += value.length / 2
      if (total > MAX_METADATA_OUTPUT_BYTES) throw new Error('xattr output too large')
      xattrs.push({ name, value: Buffer.from(value, 'hex').toString('base64') })
    }
    if (xattrs.length > 0) metadata.xattrs = xattrs
  } catch (error) {
    if (error instanceof CatalogCaptureError) throw error
    issues.push({
      code: 'METADATA_XATTR_UNREADABLE',
      message: 'Extended attributes could not be captured without following links',
    })
  }

  try {
    const flags = (await run('/usr/bin/stat', ['-f', '%Sf', '--', path]))
      .toString('utf8')
      .trim()
      .split(',')
      .map((flag) => flag.trim())
      .filter((flag) => flag.length > 0 && flag !== '-')
      .sort()
    if (flags.some((flag) => !/^[a-zA-Z0-9_-]+$/.test(flag))) {
      throw new Error('invalid filesystem flags output')
    }
    if (flags.length > 0) metadata.flags = flags
  } catch (error) {
    if (error instanceof CatalogCaptureError) throw error
    issues.push({
      code: 'METADATA_FLAGS_UNREADABLE',
      message: 'Filesystem flags could not be captured without following links',
    })
  }
  return { metadata, issues }
}

export function portableMetadata(
  metadata: BigStat,
  native: Pick<CapturedMetadata, 'xattrs' | 'flags'> = {},
): CapturedMetadata {
  const size = safeSize(metadata.size, Number.MAX_SAFE_INTEGER)
  return {
    mode: Number(metadata.mode & 0o7777n),
    size,
    modifiedAtNs: metadata.mtimeNs.toString(),
    ...(metadata.birthtimeNs > 0n ? { createdAtNs: metadata.birthtimeNs.toString() } : {}),
    ...native,
  }
}

export async function readStableRegularFile(
  path: string,
  options: CaptureOptions = {},
  guard?: CapturePathGuard,
): Promise<{ content: Buffer; metadata: BigStat }> {
  const attempts = validateAttempts(options.attempts)
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new CatalogCaptureError('INVALID_CAPTURE_LIMIT', 'Capture size limit is invalid')
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await guard?.assertStable()
    await options.onBeforeFileOpen?.(path, attempt)
    await guard?.assertStable()
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new CatalogCaptureError(
          'SOURCE_SYMLINK_ESCAPE',
          'Source became a symbolic link during capture',
        )
      }
      throw new CatalogCaptureError('SOURCE_UNREADABLE', 'Source file cannot be opened safely')
    }

    let content: Buffer | undefined
    let reservedBytes = 0
    try {
      const before = (await file.stat({ bigint: true })) as BigStat
      if (!before.isFile()) {
        throw new CatalogCaptureError('SOURCE_TYPE_CHANGED', 'Source is not a regular file')
      }
      const size = safeSize(before.size, maxBytes)
      options.memoryBudget?.reserve(size)
      reservedBytes = size
      await guard?.assertStable()
      await options.onReadAttempt?.(path, attempt)
      await guard?.assertStable()
      const buffer = Buffer.allocUnsafe(size)
      let offset = 0
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, null)
        if (read.bytesRead === 0) break
        offset += read.bytesRead
      }
      const extra = Buffer.allocUnsafe(1)
      const extraRead = await file.read(extra, 0, 1, null)
      content = buffer.subarray(0, offset)
      await guard?.assertStable()
      const after = (await file.stat({ bigint: true })) as BigStat
      let pathAfter: BigStat | undefined
      try {
        pathAfter = (await lstat(path, { bigint: true })) as BigStat
      } catch {
        // A replaced path is handled as an unstable attempt below.
      }
      if (
        offset === size &&
        extraRead.bytesRead === 0 &&
        metadataMatches(before, after) &&
        pathAfter?.isFile() &&
        metadataMatches(before, pathAfter)
      ) {
        await guard?.assertStable()
        return { content, metadata: after }
      }
    } catch (error) {
      content?.fill(0)
      options.memoryBudget?.release(reservedBytes)
      throw error
    } finally {
      await file.close().catch(() => {
        // The read result is discarded if close fails elsewhere in the attempt.
      })
    }
    content?.fill(0)
    options.memoryBudget?.release(reservedBytes)
  }

  throw new CatalogCaptureError(
    'SOURCE_UNSTABLE',
    'Source file changed during every bounded capture attempt',
  )
}

import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rmdir,
  stat,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, normalize, parse, resolve } from 'node:path'
import { RepositoryError } from './errors.js'
import type {
  RepositoryIntent,
  TargetCapabilities,
  TargetIdentity,
  TargetPreflight,
} from './types.js'

const DISKUTIL_EXECUTABLE = '/usr/sbin/diskutil'
const PLUTIL_EXECUTABLE = '/usr/bin/plutil'
const MOUNT_EXECUTABLE = '/sbin/mount'
const MAX_NATIVE_COMMAND_OUTPUT_BYTES = 1024 * 1024
const VOLUME_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STABLE_IDENTITY_PATTERN =
  /^(?:volume:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|network-sha256:[0-9a-f]{64})$/

export interface StableIdentityContext {
  resolvedPath: string
  mountPath: string
  deviceId: string
  fileSystemType: string
}

export type StableTargetIdentityResolver = (context: StableIdentityContext) => Promise<string>

export type BoundedNativeCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  input?: Uint8Array,
) => Promise<Buffer>

export interface PreflightTargetOptions {
  intent: RepositoryIntent
  requiredBytes?: bigint
  expectedIdentity?: TargetIdentity
  stableIdentityResolver?: StableTargetIdentityResolver
}

async function runBoundedNativeCommand(
  executable: string,
  arguments_: readonly string[],
  input?: Uint8Array,
): Promise<Buffer> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, [...arguments_], { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let length = 0
    let settled = false

    const fail = () => {
      if (settled) return
      settled = true
      child.kill()
      rejectCommand(new Error('Native target identity command failed'))
    }
    child.once('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > MAX_NATIVE_COMMAND_OUTPUT_BYTES) {
        fail()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        rejectCommand(new Error('Native target identity command failed'))
        return
      }
      resolveCommand(Buffer.concat(chunks, length))
    })
    child.stdin.once('error', fail)
    child.stdin.end(input)
  })
}

function parseRemoteMountSource(output: string, mountPath: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.*?) on (.*?) \(([^)]*)\)$/.exec(line)
    if (!match || normalize(match[2]) !== normalize(mountPath)) continue
    const source = match[1]
    if (!source || source.startsWith('/dev/') || source.startsWith('map ')) return null
    return source
  }
  return null
}

function canonicalizeRemoteMountSource(source: string): string {
  const trimmed = source.trim()
  if (!trimmed || trimmed.includes('\0')) throw new Error('Remote mount source is invalid')

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed)
    if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
      throw new Error('Remote mount source is incomplete')
    }
    const hostAndPort = parsed.port
      ? `${parsed.hostname.toLowerCase()}:${parsed.port}`
      : parsed.hostname.toLowerCase()
    return `${hostAndPort}${normalize(parsed.pathname)}`
  }

  if (trimmed.startsWith('//')) {
    const separator = trimmed.indexOf('/', 2)
    if (separator < 0) throw new Error('Remote mount source is incomplete')
    const authority = trimmed.slice(2, separator)
    const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase()
    const share = normalize(trimmed.slice(separator))
    if (!hostAndPort || share === '/') throw new Error('Remote mount source is incomplete')
    return `${hostAndPort}${share}`
  }

  const exportSeparator = trimmed.lastIndexOf(':/')
  if (exportSeparator > 0) {
    const authority = trimmed.slice(0, exportSeparator)
    const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase()
    const exportedPath = normalize(trimmed.slice(exportSeparator + 1))
    if (!hostAndPort || exportedPath === '/') throw new Error('Remote mount source is incomplete')
    return `${hostAndPort}:${exportedPath}`
  }

  throw new Error('Remote mount source has no stable server/share identity')
}

export function createMacOsStableIdentityResolver(
  runner: BoundedNativeCommandRunner = runBoundedNativeCommand,
): StableTargetIdentityResolver {
  return async ({ mountPath, fileSystemType }) => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      throw new Error('Stable target identity is supported only on Apple Silicon macOS')
    }

    try {
      const mountOutput = await runner(MOUNT_EXECUTABLE, [])
      const source = parseRemoteMountSource(mountOutput.toString('utf8'), mountPath)
      if (source) {
        const canonicalSource = canonicalizeRemoteMountSource(source)
        const digest = createHash('sha256')
          .update(fileSystemType)
          .update('\0')
          .update(canonicalSource)
          .digest('hex')
        return `network-sha256:${digest}`
      }
    } catch {}

    try {
      const diskInfo = await runner(DISKUTIL_EXECUTABLE, ['info', '-plist', mountPath])
      const volumeUuid = (
        await runner(PLUTIL_EXECUTABLE, ['-extract', 'VolumeUUID', 'raw', '-o', '-', '-'], diskInfo)
      )
        .toString('utf8')
        .trim()
      if (VOLUME_UUID_PATTERN.test(volumeUuid)) return `volume:${volumeUuid.toLowerCase()}`
    } catch {}
    throw new Error('Stable target identity could not be established')
  }
}

const defaultStableIdentityResolver = createMacOsStableIdentityResolver()

async function findMountPath(targetPath: string, deviceId: bigint): Promise<string> {
  let current = targetPath
  const root = parse(current).root

  while (current !== root) {
    const parent = dirname(current)
    const parentStat = await stat(parent, { bigint: true })
    if (parentStat.dev !== deviceId) return current
    current = parent
  }

  return root
}

export async function readTargetIdentity(
  targetPath: string,
  stableIdentityResolver: StableTargetIdentityResolver = defaultStableIdentityResolver,
): Promise<TargetIdentity> {
  const resolved = await realpath(targetPath)
  const targetStat = await stat(resolved, { bigint: true })
  const fileSystem = await statfs(resolved, { bigint: true })
  const deviceId = targetStat.dev.toString()
  const fileSystemType = fileSystem.type.toString()
  const mountPath = await findMountPath(resolved, targetStat.dev)
  const stableIdentity = await stableIdentityResolver({
    resolvedPath: resolved,
    mountPath,
    deviceId,
    fileSystemType,
  })
  if (!STABLE_IDENTITY_PATTERN.test(stableIdentity)) {
    throw new Error('Stable target identity is invalid')
  }

  return {
    deviceId,
    fileSystemType,
    mountPath,
    stableIdentity,
  }
}

export function targetIdentityMatches(actual: TargetIdentity, expected: TargetIdentity): boolean {
  return (
    actual.stableIdentity === expected.stableIdentity &&
    actual.fileSystemType === expected.fileSystemType &&
    normalize(actual.mountPath) === normalize(expected.mountPath)
  )
}

async function removeProbeFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}

async function probeWriteCapabilities(targetPath: string): Promise<void> {
  const probeDirectory = join(targetPath, `.restore-capability-${randomUUID()}`)
  const pending = join(probeDirectory, 'pending')
  const published = join(probeDirectory, 'published')
  const expected = randomBytes(32)
  let failure: unknown

  try {
    await mkdir(probeDirectory, { mode: 0o700 })
    await writeFile(pending, expected, { flag: 'wx', mode: 0o600 })
    const initialRead = await readFile(pending)
    if (initialRead.length !== expected.length || !timingSafeEqual(initialRead, expected)) {
      throw new Error('readback mismatch')
    }

    await rename(pending, published)
    const renamedRead = await readFile(published)
    if (renamedRead.length !== expected.length || !timingSafeEqual(renamedRead, expected)) {
      throw new Error('rename readback mismatch')
    }
  } catch (error) {
    failure = error
  }

  try {
    await removeProbeFile(pending)
    await removeProbeFile(published)
    await rmdir(probeDirectory)
  } catch (error) {
    failure ??= error
  }

  if (failure) {
    throw new RepositoryError(
      'destination',
      'TARGET_CAPABILITY_FAILED',
      'Target failed the writable, readback, or atomic rename capability check',
    )
  }
}

export async function preflightTarget(
  targetPath: string,
  options: PreflightTargetOptions,
): Promise<TargetPreflight> {
  const resolved = resolve(targetPath)
  let targetStat: Awaited<ReturnType<typeof lstat>>

  try {
    targetStat = await lstat(resolved)
  } catch {
    throw new RepositoryError(
      'destination',
      'TARGET_MISSING',
      'Target directory does not exist; Restore will not create a replacement target',
    )
  }

  if (!targetStat.isDirectory()) {
    throw new RepositoryError('destination', 'TARGET_NOT_DIRECTORY', 'Target is not a directory')
  }

  try {
    await access(resolved, constants.R_OK)
  } catch {
    throw new RepositoryError('destination', 'TARGET_NOT_READABLE', 'Target is not readable')
  }

  let identity: TargetIdentity
  try {
    identity = await readTargetIdentity(resolved, options.stableIdentityResolver)
  } catch {
    throw new RepositoryError(
      'destination',
      'TARGET_INSPECTION_FAILED',
      'Target filesystem identity could not be inspected',
    )
  }
  if (options.expectedIdentity && !targetIdentityMatches(identity, options.expectedIdentity)) {
    throw new RepositoryError(
      'destination',
      'TARGET_IDENTITY_MISMATCH',
      'Target filesystem identity does not match the initialized repository',
    )
  }

  let fileSystem: Awaited<ReturnType<typeof statfs>>
  try {
    fileSystem = await statfs(resolved, { bigint: true })
  } catch {
    throw new RepositoryError(
      'destination',
      'TARGET_INSPECTION_FAILED',
      'Target filesystem capacity could not be inspected',
    )
  }
  const availableBytes = fileSystem.bavail * fileSystem.bsize
  const requiredBytes = options.requiredBytes ?? 0n
  if (requiredBytes < 0n) {
    throw new RepositoryError(
      'configuration',
      'INVALID_REQUIRED_BYTES',
      'Required space must not be negative',
    )
  }
  if (availableBytes < requiredBytes) {
    throw new RepositoryError(
      'destination',
      'TARGET_SPACE_INSUFFICIENT',
      'Target does not have enough available space for this operation',
    )
  }

  const writeChecked = options.intent === 'write'
  if (writeChecked) await probeWriteCapabilities(resolved)

  const capabilities: TargetCapabilities = {
    readable: true,
    writeChecked,
    writable: writeChecked,
    readback: writeChecked,
    atomicRename: writeChecked,
  }

  return { path: await realpath(resolved), identity, capabilities, availableBytes }
}

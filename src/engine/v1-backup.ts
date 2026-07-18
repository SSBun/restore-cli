import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { arch, hostname, platform, release } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { capturePlan } from '../catalog/capture.js'
import { sourceContractFingerprint } from '../catalog/scope.js'
import type { CaptureOptions } from '../catalog/stable-read.js'
import { CatalogCaptureError } from '../catalog/stable-read.js'
import type {
  CapturePlan,
  CaptureResult,
  CapturedEntry,
  CapturedMetadata,
} from '../catalog/types.js'
import type { PlaintextSecretAcceptance } from '../config/types.js'
import type { CredentialProvider } from '../protection/credentials.js'
import { ProtectionError } from '../protection/errors.js'
import {
  RepositoryError,
  acquireRepositoryLock,
  assertRepositoryLockOwnership,
  createOperationResult,
  openRepository,
} from '../repository/index.js'
import type {
  ClassifiedIssue,
  OperationCategory,
  OperationResult,
  OperationState,
  ProtectionMode,
  RepositoryHandle,
  RepositoryLock,
} from '../repository/index.js'
import { readBoundedRegularFile, syncDirectory } from '../repository/io.js'

const POINT_FORMAT_VERSION = 1 as const
const MAX_PROTECTED_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_PROTECTED_BLOB_BYTES = 64 * 1024 * 1024 + 1024
const MAX_POINT_DESCRIPTOR_BYTES = 64 * 1024
const POINT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/
const MAX_WORKER_OUTPUT_BYTES = 4096
const DIRECTORY_BOUND_WRITE_WORKER = String.raw`
const fs = require('node:fs')
const [fileName, expectedDevice, expectedInode, expectedLengthValue] = process.argv.slice(1)
const blob = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const named = new Set(['manifest.enc', 'manifest.json', 'point.json'])
let directory
let file
let payload
try {
  directory = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY)
  process.stderr.write('CWD_BOUND\n')
  const acknowledgement = Buffer.alloc(1)
  if (fs.readSync(3, acknowledgement, 0, 1, null) !== 1 || acknowledgement[0] !== 1) {
    throw new Error('parent acknowledgement missing')
  }
  const held = fs.fstatSync(directory, { bigint: true })
  if (!held.isDirectory() || held.dev !== BigInt(expectedDevice) || held.ino !== BigInt(expectedInode)) {
    throw new Error('cwd identity mismatch')
  }
  if (!blob.test(fileName) && !named.has(fileName)) throw new Error('invalid file name')
  const expectedLength = Number(expectedLengthValue)
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > ${MAX_PROTECTED_BLOB_BYTES}) {
    throw new Error('invalid payload length')
  }
  payload = fs.readFileSync(0)
  if (payload.length !== expectedLength) throw new Error('payload length mismatch')
  file = fs.openSync(
    fileName,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  )
  const opened = fs.fstatSync(file, { bigint: true })
  const current = fs.lstatSync(fileName, { bigint: true })
  if (
    !opened.isFile() ||
    !current.isFile() ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino ||
    opened.size !== 0n ||
    current.size !== 0n
  ) {
    throw new Error('new file identity mismatch')
  }
  let offset = 0
  while (offset < payload.length) {
    const written = fs.writeSync(file, payload, offset, payload.length - offset)
    if (written < 1) throw new Error('short write')
    offset += written
  }
  fs.fsyncSync(file)
  const completed = fs.fstatSync(file, { bigint: true })
  if (!completed.isFile() || completed.size !== BigInt(payload.length)) {
    throw new Error('completed file mismatch')
  }
  fs.closeSync(file)
  file = undefined
  process.stdout.write(
    JSON.stringify({
      ok: true,
      device: completed.dev.toString(),
      inode: completed.ino.toString(),
      size: completed.size.toString(),
    }),
  )
} catch {
  process.stdout.write(JSON.stringify({ ok: false }))
  process.exitCode = 1
} finally {
  if (payload) payload.fill(0)
  if (file !== undefined) {
    try { fs.closeSync(file) } catch {}
  }
  if (directory !== undefined) {
    try { fs.closeSync(directory) } catch {}
  }
}
`
const DIRECTORY_BOUND_RENAME_WORKER = String.raw`
const fs = require('node:fs')
const [fromName, toName, expectedDevice, expectedInode, outputMode] = process.argv.slice(1)
const point = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/
let committed = false
let directory
try {
  if (!point.test(toName) || fromName !== toName + '.pending') throw new Error('invalid names')
  if (!['normal', 'suppress-after-commit', 'malformed-after-commit'].includes(outputMode)) {
    throw new Error('invalid output mode')
  }
  directory = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY)
  const held = fs.fstatSync(directory, { bigint: true })
  if (!held.isDirectory() || held.dev !== BigInt(expectedDevice) || held.ino !== BigInt(expectedInode)) {
    throw new Error('cwd identity mismatch')
  }
  const source = fs.lstatSync(fromName, { bigint: true })
  if (!source.isDirectory() || source.isSymbolicLink()) throw new Error('invalid pending directory')
  try {
    fs.lstatSync(toName)
    throw new Error('destination exists')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  fs.renameSync(fromName, toName)
  committed = true
  fs.fsyncSync(directory)
  if (outputMode === 'malformed-after-commit') process.stdout.write('{')
  else if (outputMode !== 'suppress-after-commit') {
    process.stdout.write(JSON.stringify({ committed, durable: true }))
  }
} catch {
  process.stdout.write(JSON.stringify({ committed, durable: false }))
  process.exitCode = 1
} finally {
  if (directory !== undefined) {
    try { fs.closeSync(directory) } catch {}
  }
}
`

export type BackupWriteStage =
  | 'content-written'
  | 'manifest-written'
  | 'before-publish'
  | 'after-publish'
  | 'after-publish-sync'

export interface BackupWriteStageContext {
  stage: BackupWriteStage
  pendingPath: string
  pointPath: string
  path: string
}

export interface V1BackupOptions {
  repositoryPath: string
  expectedRepositoryId: string
  expectedProtection: ProtectionMode
  credentialProvider?: CredentialProvider
  plan: CapturePlan
  plaintextSecretAcceptances?: PlaintextSecretAcceptance[]
  pointId?: string
  dryRun?: boolean
  cliVersion?: string
  now?: () => Date
  capture?: CaptureOptions
  /** Exact metadata imported from an authenticated source after staged content verification. */
  capturedMetadataOverrides?: V1CapturedMetadataOverride[]
  /** An active repository-bound lease owned and released by the caller. */
  heldLock?: RepositoryLock
  onStage?: (context: BackupWriteStageContext) => void | Promise<void>
  cleanupPending?: (path: string) => Promise<void>
  beforeCapture?: () => Promise<void>
  beforeRepositoryPathHold?: (pointsPath: string) => void | Promise<void>
  beforeGuardedFileOpen?: (path: string) => void | Promise<void>
  /** Test-only synchronization hook after the writer child has bound its cwd descriptor. */
  onGuardedWriterCwdBound?: (parentPath: string) => void | Promise<void>
  beforeDirectoryBoundCommit?: (pointsPath: string) => void | Promise<void>
  /** Test-only fault injection for a lost successful commit acknowledgement. */
  commitWorkerOutputMode?: 'normal' | 'suppress-after-commit' | 'malformed-after-commit'
}

export interface V1CapturedMetadataOverride {
  sourceId: string
  relativePath: string
  type: CapturedEntry['type']
  metadata: Pick<CapturedMetadata, 'mode' | 'size' | 'modifiedAtNs'>
}

interface ManifestBlob {
  id: string
  entryId: string
  path: string
  contentHash: string
  plaintextBytes: number
  protectedBytes: number
}

export interface RecoveryPointManifestV1 {
  formatVersion: typeof POINT_FORMAT_VERSION
  pointId: string
  startedAt: string
  completedAt: string
  sourceHost: {
    hostname: string
    platform: string
    osRelease: string
    architecture: string
  }
  cliVersion: string
  repositoryId: string
  protection: ProtectionMode
  health: 'healthy' | 'partial'
  verification: 'content-readback'
  plugins: string[]
  sources: Array<{
    id: string
    plugin: string
    name: string
    declaredPath: string
    resolvedPath: string
    requirement: string
    sensitivity: string
    expectedType: string
    recoveryScope: string
    consistencyGroup?: string
    includeEmptyDirectories: boolean
    status: string
    entryIds: string[]
  }>
  entries: Array<Omit<CapturedEntry, 'content' | 'identity'> & { blobId?: string }>
  blobs: ManifestBlob[]
  warnings: Array<{ code: string; sourceId: string; message: string; severity: string }>
  consistencyGroupsFailed: string[]
  plaintextSecretAcceptances: PlaintextSecretAcceptance[]
}

interface PointDescriptorV1 {
  formatVersion: typeof POINT_FORMAT_VERSION
  pointId: string
  startedAt: string
  completedAt: string
  protection: ProtectionMode
  publication: 'verified'
  manifest: 'manifest.enc' | 'manifest.json'
}

class BackupFailure extends Error {
  readonly category: Exclude<OperationCategory, 'success' | 'warning' | 'partial'>
  readonly code: string

  constructor(
    category: Exclude<OperationCategory, 'success' | 'warning' | 'partial'>,
    code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BackupFailure'
    this.category = category
    this.code = code
  }
}

interface HeldRepositoryDirectory {
  path: string
  handle: Awaited<ReturnType<typeof open>>
  device: bigint
  inode: bigint
}

class RepositoryPathGuard {
  readonly #directories = new Map<string, HeldRepositoryDirectory>()

  async holdChain(path: string): Promise<void> {
    let current = resolve('/')
    await this.holdDirectory(current)
    for (const component of resolve(path).split(sep).filter(Boolean)) {
      current = join(current, component)
      await this.holdDirectory(current)
    }
  }

  async holdDirectory(path: string): Promise<void> {
    const canonical = resolve(path)
    if (this.#directories.has(canonical)) return
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(
        canonical,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      )
    } catch {
      throw new BackupFailure(
        'destination',
        'UNSAFE_REPOSITORY_PATH',
        'Repository directory identity could not be held safely',
      )
    }
    try {
      const held = await handle.stat({ bigint: true })
      const current = await lstat(canonical, { bigint: true })
      if (
        !held.isDirectory() ||
        !current.isDirectory() ||
        held.dev !== current.dev ||
        held.ino !== current.ino
      ) {
        throw new BackupFailure(
          'destination',
          'UNSAFE_REPOSITORY_PATH',
          'Repository directory identity changed while being held',
        )
      }
      this.#directories.set(canonical, {
        path: canonical,
        handle,
        device: held.dev,
        inode: held.ino,
      })
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  async assertDirectoryStable(path: string): Promise<void> {
    const directory = this.#directories.get(resolve(path))
    if (!directory) {
      throw new BackupFailure(
        'destination',
        'UNSAFE_REPOSITORY_PATH',
        'Repository directory identity was not held',
      )
    }
    let held: BigIntStats
    let current: BigIntStats
    try {
      held = await directory.handle.stat({ bigint: true })
      current = await lstat(directory.path, { bigint: true })
    } catch {
      throw new BackupFailure(
        'destination',
        'UNSAFE_REPOSITORY_PATH',
        'Repository directory disappeared during backup',
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
      throw new BackupFailure(
        'destination',
        'UNSAFE_REPOSITORY_PATH',
        'Repository parent directory was replaced during backup',
      )
    }
  }

  async assertStable(): Promise<void> {
    for (const directory of this.#directories.values()) {
      await this.assertDirectoryStable(directory.path)
    }
  }

  identity(path: string): { device: bigint; inode: bigint } {
    const directory = this.#directories.get(resolve(path))
    if (!directory) {
      throw new BackupFailure(
        'destination',
        'UNSAFE_REPOSITORY_PATH',
        'Repository directory identity was not held',
      )
    }
    return { device: directory.device, inode: directory.inode }
  }

  async moveHeldDirectory(from: string, to: string): Promise<void> {
    const fromPath = resolve(from)
    const toPath = resolve(to)
    const previous = this.#directories.get(fromPath)
    if (!previous) {
      throw new BackupFailure(
        'destination',
        'UNSAFE_REPOSITORY_PATH',
        'Published repository directory identity was not held',
      )
    }
    const current = await lstat(to, { bigint: true })
    if (
      !current.isDirectory() ||
      current.dev !== previous.device ||
      current.ino !== previous.inode
    ) {
      throw new BackupFailure(
        'destination',
        'UNSAFE_REPOSITORY_PATH',
        'Published repository directory identity did not match pending state',
      )
    }
    const moved = [...this.#directories.values()].filter(
      (directory) => directory.path === fromPath || directory.path.startsWith(`${fromPath}${sep}`),
    )
    for (const directory of moved) this.#directories.delete(directory.path)
    for (const directory of moved) {
      directory.path = `${toPath}${directory.path.slice(fromPath.length)}`
      this.#directories.set(directory.path, directory)
    }
    await this.assertStable()
  }

  async releaseUnder(path: string): Promise<void> {
    const prefix = `${resolve(path)}${sep}`
    const selected = [...this.#directories.values()]
      .filter((directory) => directory.path === resolve(path) || directory.path.startsWith(prefix))
      .sort((left, right) => right.path.length - left.path.length)
    for (const directory of selected) {
      this.#directories.delete(directory.path)
      await directory.handle.close().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    const directories = [...this.#directories.values()].reverse()
    this.#directories.clear()
    for (const directory of directories) await directory.handle.close().catch(() => undefined)
  }
}

interface DirectoryBoundWriteResult {
  ok: boolean
  device?: string
  inode?: string
  size?: string
}

async function runDirectoryBoundWriter(
  parentPath: string,
  fileName: string,
  data: Buffer,
  identity: { device: bigint; inode: bigint },
  options: V1BackupOptions,
): Promise<DirectoryBoundWriteResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        DIRECTORY_BOUND_WRITE_WORKER,
        fileName,
        identity.device.toString(),
        identity.inode.toString(),
        data.length.toString(),
      ],
      {
        cwd: parentPath,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let cwdBound = false
    let forcedError: Error | undefined
    const control = child.stdio[3]
    const timeout = setTimeout(() => {
      forcedError = new Error('directory-bound writer timed out')
      child.kill('SIGKILL')
    }, 30_000)
    timeout.unref()

    const abort = (error: Error): void => {
      if (!forcedError) forcedError = error
      child.stdin?.destroy()
      if (control && 'destroy' in control) control.destroy()
      child.kill('SIGKILL')
    }
    child.stdin?.on('error', () => undefined)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_WORKER_OUTPUT_BYTES) {
        abort(new Error('directory-bound writer output exceeded limit'))
        return
      }
      stdout.push(Buffer.from(chunk))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_WORKER_OUTPUT_BYTES) {
        abort(new Error('directory-bound writer diagnostics exceeded limit'))
        return
      }
      stderr.push(Buffer.from(chunk))
      const diagnostic = Buffer.concat(stderr, stderrBytes).toString('ascii')
      if (cwdBound || !diagnostic.includes('CWD_BOUND\n')) return
      cwdBound = true
      void Promise.resolve(options.onGuardedWriterCwdBound?.(parentPath))
        .then(() => {
          if (!control || !('end' in control)) {
            abort(new Error('directory-bound writer control channel is unavailable'))
            return
          }
          control.end(Buffer.from([1]))
        })
        .catch((error: unknown) => abort(error instanceof Error ? error : new Error('hook failed')))
    })
    child.once('error', (error) => abort(error))
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      child.stdin?.destroy()
      if (control && 'destroy' in control) control.destroy()
      if (forcedError) {
        rejectResult(forcedError)
        return
      }
      if (code !== 0 || signal !== null || !cwdBound) {
        resolveResult({ ok: false })
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout, stdoutBytes).toString('utf8')) as Record<
          string,
          unknown
        >
        resolveResult({
          ok: parsed.ok === true,
          ...(typeof parsed.device === 'string' ? { device: parsed.device } : {}),
          ...(typeof parsed.inode === 'string' ? { inode: parsed.inode } : {}),
          ...(typeof parsed.size === 'string' ? { size: parsed.size } : {}),
        })
      } catch {
        resolveResult({ ok: false })
      }
    })
    child.stdin?.end(data)
  })
}

async function writeGuardedExclusiveFile(
  path: string,
  data: Buffer,
  guard: RepositoryPathGuard,
  options: V1BackupOptions,
): Promise<void> {
  await guard.assertStable()
  await options.beforeGuardedFileOpen?.(path)
  const parentPath = dirname(path)
  const identity = guard.identity(parentPath)
  try {
    const result = await runDirectoryBoundWriter(
      parentPath,
      basename(path),
      data,
      identity,
      options,
    )
    if (!result.ok || !result.device || !result.inode || !result.size) {
      throw new Error('directory-bound writer did not confirm completion')
    }
    const current = await lstat(path, { bigint: true })
    await guard.assertStable()
    if (
      !current.isFile() ||
      current.dev.toString() !== result.device ||
      current.ino.toString() !== result.inode ||
      current.size.toString() !== result.size ||
      current.size !== BigInt(data.length)
    ) {
      throw new Error('directory-bound writer result did not match repository path')
    }
  } catch (error) {
    if (error instanceof BackupFailure) throw error
    throw new BackupFailure(
      'destination',
      'REPOSITORY_FILE_WRITE_FAILED',
      'Repository file could not be created through a verified directory-bound writer',
    )
  }
}

async function directoryBoundCommit(
  pointsPath: string,
  pointId: string,
  identity: { device: bigint; inode: bigint },
  outputMode: NonNullable<V1BackupOptions['commitWorkerOutputMode']>,
): Promise<{ committed: boolean; durable: boolean }> {
  const output = await new Promise<string>((resolveOutput) => {
    execFile(
      process.execPath,
      [
        '-e',
        DIRECTORY_BOUND_RENAME_WORKER,
        `${pointId}.pending`,
        pointId,
        identity.device.toString(),
        identity.inode.toString(),
        outputMode,
      ],
      {
        cwd: pointsPath,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 4096,
        windowsHide: true,
      },
      (_error, stdout) => resolveOutput(stdout),
    )
  })
  try {
    const result = JSON.parse(output) as { committed?: unknown; durable?: unknown }
    return { committed: result.committed === true, durable: result.durable === true }
  } catch {
    return { committed: false, durable: false }
  }
}

async function lstatIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new BackupFailure(
      'destination',
      'POINT_PUBLICATION_FAILED',
      'Recovery point publication state could not be inspected',
    )
  }
}

async function reconcileDirectoryBoundCommit(
  pointsPath: string,
  pendingPath: string,
  pointPath: string,
  pendingIdentity: { device: bigint; inode: bigint },
  guard: RepositoryPathGuard,
): Promise<'committed' | 'pending' | 'ambiguous'> {
  await guard.assertDirectoryStable(pointsPath)
  const final = await lstatIfPresent(pointPath)
  const pending = await lstatIfPresent(pendingPath)
  await guard.assertDirectoryStable(pointsPath)
  const matchesPending = (metadata: BigIntStats | undefined): boolean =>
    Boolean(
      metadata?.isDirectory() &&
        metadata.dev === pendingIdentity.device &&
        metadata.ino === pendingIdentity.inode,
    )
  if (matchesPending(final) && pending === undefined) return 'committed'
  if (matchesPending(pending) && final === undefined) return 'pending'
  return 'ambiguous'
}

function safeNow(now: (() => Date) | undefined): Date {
  const value = now?.() ?? new Date()
  if (!Number.isFinite(value.getTime())) {
    throw new BackupFailure('configuration', 'INVALID_TIME', 'Backup time is invalid')
  }
  return value
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function sourceIssues(capture: CaptureResult | undefined): ClassifiedIssue[] {
  return (capture?.issues ?? []).map((issue) => ({
    code: issue.code,
    category:
      issue.severity === 'warning'
        ? 'warning'
        : issue.severity === 'partial'
          ? 'partial'
          : 'source',
    message: `${issue.sourceId}: ${issue.message}`,
  }))
}

function countsFor(
  capture: CaptureResult | undefined,
  options: { written?: number; bytesWritten?: number } = {},
) {
  const entries = capture?.entries ?? []
  const failedSources =
    capture?.sources.filter((source) => source.status === 'failed' || source.status === 'unstable')
      .length ?? 0
  const missingSources =
    capture?.sources.filter((source) => source.status === 'missing').length ?? 0
  return {
    filesConsidered: entries.length + failedSources + missingSources,
    filesWritten: options.written ?? 0,
    filesSkipped: missingSources,
    filesFailed: failedSources,
    bytesRead: entries.reduce((total, entry) => total + (entry.content?.length ?? 0), 0),
    bytesWritten: options.bytesWritten ?? 0,
  }
}

function failureDetails(error: unknown): {
  category: Exclude<OperationCategory, 'success' | 'warning' | 'partial'>
  code: string
  message: string
} {
  if (error instanceof BackupFailure) return error
  if (error instanceof CatalogCaptureError) {
    const configurationCodes = new Set(['INVALID_CAPTURE_LIMIT'])
    return {
      category: configurationCodes.has(error.code) ? 'configuration' : 'source',
      code: error.code,
      message: error.message,
    }
  }
  if (error instanceof RepositoryError) return error
  if (error instanceof ProtectionError) {
    return { category: 'authentication', code: error.code, message: error.message }
  }
  return {
    category: 'internal',
    code: 'BACKUP_FAILED',
    message: 'Backup did not complete',
  }
}

function operationResult(input: {
  state: OperationState
  category: OperationCategory
  repositoryId: string
  pointId: string
  startedAt: string
  endedAt: string
  capture?: CaptureResult
  written?: number
  bytesWritten?: number
  issues?: ClassifiedIssue[]
  verificationScope?: 'structural' | 'content'
}): OperationResult {
  return createOperationResult({
    operation: 'backup',
    state: input.state,
    category: input.category,
    repositoryId: input.repositoryId,
    pointId: input.pointId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    counts: countsFor(input.capture, {
      written: input.written,
      bytesWritten: input.bytesWritten,
    }),
    ...(input.verificationScope ? { verificationScope: input.verificationScope } : {}),
    issues: input.issues ?? [],
  })
}

function acceptedPlaintextSecrets(options: V1BackupOptions): PlaintextSecretAcceptance[] {
  if (options.expectedProtection !== 'plaintext') return []
  const provided = options.plaintextSecretAcceptances ?? []
  const accepted: PlaintextSecretAcceptance[] = []
  for (const source of options.plan.sources.filter((item) => item.sensitivity === 'secret')) {
    const record = provided.find(
      (item) =>
        item.repositoryId === options.expectedRepositoryId &&
        item.sourceId === source.id &&
        item.sourceContractFingerprint === sourceContractFingerprint(source),
    )
    if (!record || !Number.isFinite(Date.parse(record.acceptedAt))) {
      throw new BackupFailure(
        'configuration',
        'PLAINTEXT_SECRET_ACCEPTANCE_REQUIRED',
        `Plaintext secret source requires independent acceptance: ${source.id}`,
      )
    }
    accepted.push(record)
  }
  const acceptedKeys = new Set(
    accepted.map(
      (record) => `${record.repositoryId}:${record.sourceId}:${record.sourceContractFingerprint}`,
    ),
  )
  for (const record of provided) {
    if (record.repositoryId !== options.expectedRepositoryId) continue
    const key = `${record.repositoryId}:${record.sourceId}:${record.sourceContractFingerprint}`
    if (!acceptedKeys.has(key)) {
      throw new BackupFailure(
        'configuration',
        'PLAINTEXT_SECRET_ACCEPTANCE_STALE',
        'Plaintext secret acceptance does not match an enabled secret source',
      )
    }
  }
  return accepted.sort((left, right) => left.sourceId.localeCompare(right.sourceId))
}

function wipeCapture(capture: CaptureResult | undefined): void {
  for (const entry of capture?.entries ?? []) entry.content?.fill(0)
}

function applyCapturedMetadataOverrides(
  capture: CaptureResult,
  overrides: readonly V1CapturedMetadataOverride[] | undefined,
): void {
  if (!overrides) return
  if (capture.sources.some((source) => source.status !== 'captured')) {
    throw new BackupFailure(
      'integrity',
      'CAPTURED_METADATA_OVERRIDE_MISMATCH',
      'Captured metadata overrides require every source to be captured exactly',
    )
  }
  const expected = new Map<string, V1CapturedMetadataOverride>()
  for (const override of overrides) {
    const metadata = override?.metadata
    if (
      !override ||
      typeof override.sourceId !== 'string' ||
      override.sourceId.length < 1 ||
      override.sourceId.length > 1024 ||
      typeof override.relativePath !== 'string' ||
      override.relativePath.length < 1 ||
      override.relativePath.length > 8192 ||
      !['file', 'directory', 'symlink'].includes(override.type) ||
      Object.keys(override).sort().join(',') !== 'metadata,relativePath,sourceId,type' ||
      !metadata ||
      typeof metadata !== 'object' ||
      Object.keys(metadata).sort().join(',') !== 'mode,modifiedAtNs,size' ||
      !Number.isSafeInteger(metadata.mode) ||
      metadata.mode < 0 ||
      metadata.mode > 0o7777 ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      typeof metadata.modifiedAtNs !== 'string' ||
      !/^[0-9]{1,20}$/.test(metadata.modifiedAtNs)
    ) {
      throw new BackupFailure(
        'configuration',
        'INVALID_CAPTURED_METADATA_OVERRIDE',
        'Captured metadata override contract is invalid',
      )
    }
    const key = `${override.sourceId}\0${override.relativePath}`
    if (expected.has(key)) {
      throw new BackupFailure(
        'configuration',
        'INVALID_CAPTURED_METADATA_OVERRIDE',
        'Captured metadata override contract contains duplicate entries',
      )
    }
    expected.set(key, override)
  }
  if (expected.size !== capture.entries.length) {
    throw new BackupFailure(
      'integrity',
      'CAPTURED_METADATA_OVERRIDE_MISMATCH',
      'Captured metadata overrides do not cover the exact captured entry set',
    )
  }
  for (const entry of capture.entries) {
    const override = expected.get(`${entry.sourceId}\0${entry.relativePath}`)
    if (
      !override ||
      override.type !== entry.type ||
      (entry.type === 'file' && override.metadata.size !== entry.metadata.size)
    ) {
      throw new BackupFailure(
        'integrity',
        'CAPTURED_METADATA_OVERRIDE_MISMATCH',
        'Captured metadata override does not match verified staged content',
      )
    }
    entry.metadata = {
      mode: override.metadata.mode,
      size: override.metadata.size,
      modifiedAtNs: override.metadata.modifiedAtNs,
    }
  }
}

function manifestEntry(
  entry: CapturedEntry,
  blobId: string | undefined,
): Omit<CapturedEntry, 'content' | 'identity'> & { blobId?: string } {
  const { content: _content, identity: _identity, ...serializable } = entry
  return { ...serializable, ...(blobId ? { blobId } : {}) }
}

async function sealAndWriteBlobs(
  repository: RepositoryHandle,
  capture: CaptureResult,
  pendingPath: string,
  pointPath: string,
  options: V1BackupOptions,
  guard: RepositoryPathGuard,
): Promise<{ blobs: ManifestBlob[]; blobIds: Map<string, string>; bytesWritten: number }> {
  if (!repository.protector) {
    throw new BackupFailure(
      'authentication',
      'WRITE_AUTHORIZATION_REQUIRED',
      'Repository content protector is unavailable',
    )
  }
  const blobsPath = join(pendingPath, 'blobs')
  await guard.assertStable()
  await mkdir(blobsPath, { mode: 0o700 })
  await guard.holdDirectory(blobsPath)
  await guard.assertStable()
  const blobs: ManifestBlob[] = []
  const blobIds = new Map<string, string>()
  let bytesWritten = 0
  for (const entry of capture.entries) {
    if (entry.type !== 'file' || entry.hardlinkTo || !entry.content || !entry.contentHash) continue
    const blobId = randomUUID()
    const path = join(blobsPath, blobId)
    const protectedContent = await repository.protector.seal(entry.content, {
      repositoryId: repository.descriptor.repositoryId,
      purpose: 'blob',
      objectId: blobId,
    })
    try {
      await guard.assertStable()
      await writeGuardedExclusiveFile(path, protectedContent, guard, options)
      await guard.assertStable()
      bytesWritten += protectedContent.length
      blobs.push({
        id: blobId,
        entryId: entry.id,
        path: `blobs/${blobId}`,
        contentHash: entry.contentHash,
        plaintextBytes: entry.content.length,
        protectedBytes: protectedContent.length,
      })
      blobIds.set(entry.id, blobId)
      await options.onStage?.({
        stage: 'content-written',
        pendingPath,
        pointPath,
        path,
      })
      await guard.assertStable()
    } finally {
      protectedContent.fill(0)
    }
  }
  await guard.assertStable()
  await syncDirectory(blobsPath)
  await guard.assertStable()
  return { blobs, blobIds, bytesWritten }
}

function buildManifest(
  repository: RepositoryHandle,
  capture: CaptureResult,
  blobs: ManifestBlob[],
  blobIds: Map<string, string>,
  acceptedSecrets: PlaintextSecretAcceptance[],
  options: V1BackupOptions,
  pointId: string,
  startedAt: string,
  completedAt: string,
): RecoveryPointManifestV1 {
  return {
    formatVersion: POINT_FORMAT_VERSION,
    pointId,
    startedAt,
    completedAt,
    sourceHost: {
      hostname: hostname(),
      platform: platform(),
      osRelease: release(),
      architecture: arch(),
    },
    cliVersion: options.cliVersion ?? '0.1.2',
    repositoryId: repository.descriptor.repositoryId,
    protection: repository.descriptor.protection,
    health: capture.issues.some((issue) => issue.severity === 'partial') ? 'partial' : 'healthy',
    verification: 'content-readback',
    plugins: options.plan.plugins.map((plugin) => plugin.name).sort(),
    sources: capture.sources.map((captured) => ({
      id: captured.source.id,
      plugin: captured.source.plugin,
      name: captured.source.name,
      declaredPath: captured.source.declaredPath,
      resolvedPath: captured.source.path,
      requirement: captured.source.requirement,
      sensitivity: captured.source.sensitivity,
      expectedType: captured.source.expectedType,
      recoveryScope: captured.source.recoveryScope,
      ...(captured.source.consistencyGroup
        ? { consistencyGroup: captured.source.consistencyGroup }
        : {}),
      includeEmptyDirectories: captured.source.includeEmptyDirectories,
      status: captured.status,
      entryIds: captured.entryIds,
    })),
    entries: capture.entries.map((entry) => manifestEntry(entry, blobIds.get(entry.id))),
    blobs,
    warnings: capture.issues,
    consistencyGroupsFailed: capture.consistencyGroupsFailed,
    plaintextSecretAcceptances: acceptedSecrets,
  }
}

async function verifyReadback(
  repository: RepositoryHandle,
  pendingPath: string,
  manifestPath: string,
  manifest: RecoveryPointManifestV1,
  capture: CaptureResult,
  guard: RepositoryPathGuard,
): Promise<void> {
  if (!repository.protector) {
    throw new BackupFailure('authentication', 'WRITE_AUTHORIZATION_REQUIRED', 'Protector missing')
  }
  await guard.assertStable()
  const manifestProtected = await readBoundedRegularFile(manifestPath, MAX_PROTECTED_MANIFEST_BYTES)
  await guard.assertStable()
  const manifestPlaintext = await repository.protector.open(manifestProtected, {
    repositoryId: repository.descriptor.repositoryId,
    purpose: 'manifest',
    objectId: manifest.pointId,
  })
  try {
    if (manifestPlaintext.toString('utf8') !== JSON.stringify(manifest)) {
      throw new BackupFailure(
        'integrity',
        'MANIFEST_READBACK_FAILED',
        'Protected manifest readback did not match',
      )
    }
  } finally {
    manifestPlaintext.fill(0)
    manifestProtected.fill(0)
  }

  const contentByEntry = new Map(
    capture.entries
      .filter((entry): entry is CapturedEntry & { content: Buffer } => Boolean(entry.content))
      .map((entry) => [entry.id, entry.content]),
  )
  for (const blob of manifest.blobs) {
    await guard.assertStable()
    const protectedContent = await readBoundedRegularFile(
      join(pendingPath, blob.path),
      MAX_PROTECTED_BLOB_BYTES,
    )
    await guard.assertStable()
    const plaintext = await repository.protector.open(protectedContent, {
      repositoryId: repository.descriptor.repositoryId,
      purpose: 'blob',
      objectId: blob.id,
    })
    try {
      const expected = contentByEntry.get(blob.entryId)
      if (!expected || !plaintext.equals(expected)) {
        throw new BackupFailure(
          'integrity',
          'BLOB_READBACK_FAILED',
          'Protected content readback did not match',
        )
      }
    } finally {
      plaintext.fill(0)
      protectedContent.fill(0)
    }
  }
}

async function cleanupPendingSafely(
  pendingPath: string,
  guard: RepositoryPathGuard,
  customCleanup?: (path: string) => Promise<void>,
): Promise<void> {
  await guard.assertStable()
  await guard.releaseUnder(pendingPath)
  if (customCleanup) {
    await customCleanup(pendingPath)
    await guard.assertStable()
    return
  }
  const cleanupPath = `${pendingPath}.cleanup-${randomUUID()}`
  await rename(pendingPath, cleanupPath)
  await guard.assertStable()
  await rm(cleanupPath, { recursive: true, force: false })
  await guard.assertStable()
}

function resultState(
  capture: CaptureResult,
  issues: ClassifiedIssue[],
): {
  state: 'success' | 'warning' | 'partial'
  category: 'success' | 'warning' | 'partial'
} {
  if (capture.issues.some((issue) => issue.severity === 'partial')) {
    return { state: 'partial', category: 'partial' }
  }
  if (issues.length > 0) return { state: 'warning', category: 'warning' }
  return { state: 'success', category: 'success' }
}

export async function createV1RecoveryPoint(options: V1BackupOptions): Promise<OperationResult> {
  const pointId = options.pointId ?? randomUUID()
  const startedAt = safeNow(options.now).toISOString()
  const guard = new RepositoryPathGuard()
  let repository: RepositoryHandle | undefined
  let lock: Awaited<ReturnType<typeof acquireRepositoryLock>> | undefined
  let releaseOwnedLock = false
  let capture: CaptureResult | undefined
  let pendingPath: string | undefined
  let pointPath: string | undefined
  let published = false
  let contentVerified = false
  let bytesWritten = 0
  let finalResult: OperationResult | undefined

  try {
    if (!POINT_ID_PATTERN.test(pointId) || pointId.endsWith('.pending')) {
      throw new BackupFailure('configuration', 'INVALID_POINT_ID', 'Recovery point ID is invalid')
    }
    const acceptedSecrets = acceptedPlaintextSecrets(options)
    try {
      repository = await openRepository(options.repositoryPath, {
        intent: options.dryRun ? 'read' : 'write',
        expectedRepositoryId: options.expectedRepositoryId,
        expectedProtection: options.expectedProtection,
        credentialProvider: options.credentialProvider,
      })
    } catch (error) {
      if (
        options.expectedProtection === 'encrypted' &&
        !(error instanceof RepositoryError) &&
        !(error instanceof ProtectionError)
      ) {
        throw new BackupFailure(
          'authentication',
          'REPOSITORY_AUTHENTICATION_FAILED',
          'Encrypted repository authentication failed',
        )
      }
      throw error
    }
    const pointsPath = repository.layout.points
    await options.beforeRepositoryPathHold?.(pointsPath)
    await guard.holdChain(pointsPath)
    pointPath = join(pointsPath, pointId)
    pendingPath = `${pointPath}.pending`
    await guard.assertStable()
    if (await exists(pointPath)) {
      throw new BackupFailure(
        'destination',
        'DUPLICATE_RECOVERY_POINT',
        'Recovery point ID already exists',
      )
    }
    if (!options.dryRun && (await exists(pendingPath))) {
      throw new BackupFailure(
        'destination',
        'DUPLICATE_RECOVERY_POINT',
        'Recovery point pending state already exists',
      )
    }
    await guard.assertStable()
    if (!options.dryRun) {
      if (options.heldLock) lock = options.heldLock
      else {
        lock = await acquireRepositoryLock(repository, 'backup')
        releaseOwnedLock = true
      }
      await assertRepositoryLockOwnership(repository, lock)
      try {
        await options.beforeCapture?.()
      } catch {
        throw new BackupFailure('source', 'PLUGIN_PREPARE_FAILED', 'Plugin preparation failed')
      }
    }

    capture = await capturePlan(options.plan, options.capture)
    applyCapturedMetadataOverrides(capture, options.capturedMetadataOverrides)
    const catalogIssues = sourceIssues(capture)
    if (capture.requiredFailed) {
      finalResult = operationResult({
        state: 'failure',
        category: 'source',
        repositoryId: repository.descriptor.repositoryId,
        pointId,
        startedAt,
        endedAt: safeNow(options.now).toISOString(),
        capture,
        issues: catalogIssues,
        verificationScope: 'structural',
      })
    } else if (options.dryRun) {
      const outcome = resultState(capture, catalogIssues)
      finalResult = operationResult({
        ...outcome,
        repositoryId: repository.descriptor.repositoryId,
        pointId,
        startedAt,
        endedAt: safeNow(options.now).toISOString(),
        capture,
        issues: catalogIssues,
        verificationScope: 'structural',
      })
    } else {
      if (!lock) {
        throw new BackupFailure('lock', 'REPOSITORY_LOCK_REQUIRED', 'Repository lock is missing')
      }
      await assertRepositoryLockOwnership(repository, lock)
      await guard.assertStable()
      await mkdir(pendingPath, { mode: 0o700 })
      await guard.holdDirectory(pendingPath)
      await guard.assertStable()
      const sealed = await sealAndWriteBlobs(
        repository,
        capture,
        pendingPath,
        pointPath,
        options,
        guard,
      )
      bytesWritten += sealed.bytesWritten
      await assertRepositoryLockOwnership(repository, lock)
      const completedAt = safeNow(options.now).toISOString()
      const manifest = buildManifest(
        repository,
        capture,
        sealed.blobs,
        sealed.blobIds,
        acceptedSecrets,
        options,
        pointId,
        startedAt,
        completedAt,
      )
      const manifestName =
        repository.descriptor.protection === 'encrypted' ? 'manifest.enc' : 'manifest.json'
      const manifestPath = join(pendingPath, manifestName)
      if (!repository.protector) {
        throw new BackupFailure(
          'authentication',
          'WRITE_AUTHORIZATION_REQUIRED',
          'Repository protector is unavailable',
        )
      }
      // JSON.stringify creates one unavoidable immutable JS string; the explicit plaintext buffer
      // and every protected/readback buffer are still zeroed at their ownership boundaries.
      const manifestPlaintext = Buffer.from(JSON.stringify(manifest))
      let protectedManifest: Buffer | undefined
      try {
        protectedManifest = await repository.protector.seal(manifestPlaintext, {
          repositoryId: repository.descriptor.repositoryId,
          purpose: 'manifest',
          objectId: pointId,
        })
        await guard.assertStable()
        await writeGuardedExclusiveFile(manifestPath, protectedManifest, guard, options)
        await guard.assertStable()
        bytesWritten += protectedManifest.length
      } finally {
        manifestPlaintext.fill(0)
        protectedManifest?.fill(0)
      }
      await options.onStage?.({
        stage: 'manifest-written',
        pendingPath,
        pointPath,
        path: manifestPath,
      })
      await guard.assertStable()
      await verifyReadback(repository, pendingPath, manifestPath, manifest, capture, guard)
      contentVerified = true

      const descriptor: PointDescriptorV1 = {
        formatVersion: POINT_FORMAT_VERSION,
        pointId,
        startedAt,
        completedAt,
        protection: repository.descriptor.protection,
        publication: 'verified',
        manifest: manifestName,
      }
      const descriptorPath = join(pendingPath, 'point.json')
      const descriptorContent = Buffer.from(`${JSON.stringify(descriptor)}\n`)
      try {
        await guard.assertStable()
        await writeGuardedExclusiveFile(descriptorPath, descriptorContent, guard, options)
        await guard.assertStable()
        bytesWritten += descriptorContent.length
      } finally {
        descriptorContent.fill(0)
      }
      await syncDirectory(pendingPath)
      await guard.assertStable()
      await options.onStage?.({
        stage: 'before-publish',
        pendingPath,
        pointPath,
        path: descriptorPath,
      })
      await guard.assertStable()
      if (await exists(pointPath)) {
        throw new BackupFailure(
          'destination',
          'DUPLICATE_RECOVERY_POINT',
          'Recovery point ID appeared before publication',
        )
      }
      await guard.assertStable()
      await options.beforeDirectoryBoundCommit?.(pointsPath)
      await assertRepositoryLockOwnership(repository, lock)
      const pendingIdentity = guard.identity(pendingPath)
      const commit = await directoryBoundCommit(
        pointsPath,
        pointId,
        guard.identity(pointsPath),
        options.commitWorkerOutputMode ?? 'normal',
      )
      let committed = commit.committed
      let durable = commit.durable
      if (!committed) {
        const reconciled = await reconcileDirectoryBoundCommit(
          pointsPath,
          pendingPath,
          pointPath,
          pendingIdentity,
          guard,
        )
        if (reconciled === 'committed') {
          committed = true
          durable = false
        } else if (reconciled === 'ambiguous') {
          throw new BackupFailure(
            'integrity',
            'POINT_PUBLICATION_AMBIGUOUS',
            'Recovery point publication acknowledgement was lost and state is ambiguous',
          )
        }
      }
      if (!committed) {
        throw new BackupFailure(
          'destination',
          'POINT_PUBLICATION_FAILED',
          'Recovery point directory-bound publication did not commit',
        )
      }
      await guard.moveHeldDirectory(pendingPath, pointPath)
      published = true
      await assertRepositoryLockOwnership(repository, lock)
      if (!durable) {
        throw new BackupFailure(
          'destination',
          'POINT_COMMIT_DURABILITY_UNCONFIRMED',
          'Recovery point committed but points directory sync failed',
        )
      }
      await options.onStage?.({
        stage: 'after-publish',
        pendingPath,
        pointPath,
        path: pointPath,
      })
      await guard.assertStable()
      await syncDirectory(pointsPath)
      await guard.assertStable()
      await options.onStage?.({
        stage: 'after-publish-sync',
        pendingPath,
        pointPath,
        path: join(pointPath, 'point.json'),
      })
      await guard.assertStable()
      let descriptorBuffer: Buffer | undefined
      let publishedDescriptor: PointDescriptorV1
      try {
        descriptorBuffer = await readBoundedRegularFile(
          join(pointPath, 'point.json'),
          MAX_POINT_DESCRIPTOR_BYTES,
        )
        await guard.assertStable()
        publishedDescriptor = JSON.parse(descriptorBuffer.toString('utf8')) as PointDescriptorV1
      } catch (error) {
        if (error instanceof BackupFailure) throw error
        throw new BackupFailure(
          'integrity',
          'POINT_PUBLICATION_FAILED',
          'Published recovery point descriptor could not be read safely',
        )
      } finally {
        descriptorBuffer?.fill(0)
      }
      if (
        publishedDescriptor.pointId !== pointId ||
        publishedDescriptor.publication !== 'verified'
      ) {
        throw new BackupFailure(
          'integrity',
          'POINT_PUBLICATION_FAILED',
          'Published recovery point could not be verified',
        )
      }

      const outcome = resultState(capture, catalogIssues)
      finalResult = operationResult({
        ...outcome,
        repositoryId: repository.descriptor.repositoryId,
        pointId,
        startedAt,
        endedAt: safeNow(options.now).toISOString(),
        capture,
        written: capture.entries.length,
        bytesWritten,
        issues: catalogIssues,
        verificationScope: 'content',
      })
    }
  } catch (error) {
    const classified = failureDetails(error)
    const failure =
      published && classified.code === 'BACKUP_FAILED'
        ? {
            category: 'destination' as const,
            code: 'POINT_COMMIT_DURABILITY_UNCONFIRMED',
            message: 'Recovery point committed but final durability could not be confirmed',
          }
        : classified
    const issues: ClassifiedIssue[] = [
      ...sourceIssues(capture),
      { code: failure.code, category: failure.category, message: failure.message },
    ]
    if (pendingPath && !published && (await exists(pendingPath).catch(() => false))) {
      try {
        if (!options.dryRun && repository && lock) {
          await assertRepositoryLockOwnership(repository, lock)
        }
        await cleanupPendingSafely(pendingPath, guard, options.cleanupPending)
      } catch {
        issues.push({
          code: 'PENDING_CLEANUP_FAILED',
          category: 'destination',
          message: 'Diagnostic pending state was preserved because cleanup failed',
        })
      }
    }
    finalResult = operationResult({
      state: published ? 'degraded' : 'failure',
      category: failure.category,
      repositoryId: repository?.descriptor.repositoryId ?? options.expectedRepositoryId,
      pointId,
      startedAt,
      endedAt: safeNow(options.now).toISOString(),
      capture,
      written: published ? capture?.entries.length : 0,
      bytesWritten: published ? bytesWritten : 0,
      issues,
      ...(published && contentVerified
        ? { verificationScope: 'content' as const }
        : capture
          ? { verificationScope: 'structural' as const }
          : {}),
    })
  }

  try {
    if (releaseOwnedLock) await lock?.release()
  } catch (error) {
    const failure = failureDetails(error)
    const lockIssue: ClassifiedIssue = {
      code: failure.code,
      category: 'lock',
      message: 'Repository lock release failed',
    }
    if (
      published &&
      finalResult &&
      (finalResult.state === 'success' ||
        finalResult.state === 'warning' ||
        finalResult.state === 'partial')
    ) {
      finalResult = operationResult({
        state: 'degraded',
        category: 'lock',
        repositoryId: repository?.descriptor.repositoryId ?? options.expectedRepositoryId,
        pointId,
        startedAt,
        endedAt: safeNow(options.now).toISOString(),
        capture,
        written: capture?.entries.length,
        bytesWritten,
        issues: [...finalResult.issues, lockIssue],
        verificationScope: contentVerified ? 'content' : 'structural',
      })
    } else if (finalResult) {
      finalResult = operationResult({
        state: finalResult.state,
        category: finalResult.category,
        repositoryId: repository?.descriptor.repositoryId ?? options.expectedRepositoryId,
        pointId,
        startedAt,
        endedAt: safeNow(options.now).toISOString(),
        capture,
        written: finalResult.counts.filesWritten,
        bytesWritten: finalResult.counts.bytesWritten,
        issues: [...finalResult.issues, lockIssue],
        ...(finalResult.verificationScope
          ? { verificationScope: finalResult.verificationScope }
          : {}),
      })
    }
  } finally {
    await guard.close()
    repository?.close()
    wipeCapture(capture)
  }
  if (!finalResult) throw new Error('Backup result was not produced')
  return finalResult
}

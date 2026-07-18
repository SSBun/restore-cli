import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialProvider } from '../protection/credentials.js'
import { ProtectionError } from '../protection/errors.js'
import { RepositoryError, acquireRepositoryLock, openRepository } from '../repository/index.js'
import type {
  ClassifiedIssue,
  OperationCategory,
  OperationState,
  ProtectionMode,
  RepositoryHandle,
  RepositoryLock,
} from '../repository/index.js'
import { discoverVisiblePoints, verifyV1Repository } from '../verify/index.js'
import type { DiscoveredPoint, PointHealth } from '../verify/index.js'

const DEFAULT_HEALTHY_RETENTION = 14
const MAX_WORKER_OUTPUT = 4096
const MAX_ESTIMATE_ENTRIES = 200_000
const DIRECTORY_BOUND_QUARANTINE_WORKER = String.raw`
const fs = require('node:fs')
const [pointId, quarantineName, parentDevice, parentInode, pointDevice, pointInode] = process.argv.slice(1)
const point = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/
let parent
try {
  const quarantinePrefix = pointId + '.retention-'
  const quarantineId = quarantineName.slice(quarantinePrefix.length)
  if (!point.test(pointId) || !quarantineName.startsWith(quarantinePrefix) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(quarantineId)) throw new Error('invalid names')
  parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const parentStat = fs.fstatSync(parent, { bigint: true })
  if (parentStat.dev !== BigInt(parentDevice) || parentStat.ino !== BigInt(parentInode)) throw new Error('parent changed')
  const source = fs.lstatSync(pointId, { bigint: true })
  if (!source.isDirectory() || source.isSymbolicLink() || source.dev !== BigInt(pointDevice) || source.ino !== BigInt(pointInode)) throw new Error('point changed')
  fs.renameSync(pointId, quarantineName)
  fs.fsyncSync(parent)
  const moved = fs.lstatSync(quarantineName, { bigint: true })
  if (!moved.isDirectory() || moved.dev !== source.dev || moved.ino !== source.ino) throw new Error('quarantine changed')
  process.stdout.write(JSON.stringify({ quarantined: true, device: moved.dev.toString(), inode: moved.ino.toString() }))
} catch {
  process.stdout.write(JSON.stringify({ quarantined: false }))
  process.exitCode = 1
} finally { if (parent !== undefined) try { fs.closeSync(parent) } catch {} }
`
const PHYSICAL_DELETE_WORKER = String.raw`
const childProcess = require('node:child_process')
const fs = require('node:fs')
const [quarantineName, rootDevice, rootInode, parentDevice, parentInode] = process.argv.slice(1)
let root
let parent
function acknowledge() {
  const byte = Buffer.alloc(1)
  if (fs.readSync(3, byte, 0, 1, null) !== 1 || byte[0] !== 1) throw new Error('ack missing')
}
try {
  root = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  parent = fs.openSync('..', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const rootStat = fs.fstatSync(root, { bigint: true })
  const parentStat = fs.fstatSync(parent, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.dev !== BigInt(rootDevice) || rootStat.ino !== BigInt(rootInode)) throw new Error('root changed')
  if (!parentStat.isDirectory() || parentStat.dev !== BigInt(parentDevice) || parentStat.ino !== BigInt(parentInode)) throw new Error('parent changed')
  process.stderr.write('CWD_BOUND\n')
  acknowledge()
  childProcess.execFileSync('/usr/bin/find', ['-P', '-x', '.', '-depth', '-mindepth', '1', '-delete'], {
    stdio: 'ignore', timeout: 30000, windowsHide: true,
  })
  const afterDelete = fs.fstatSync(root, { bigint: true })
  if (afterDelete.dev !== rootStat.dev || afterDelete.ino !== rootStat.ino || fs.readdirSync('.').length !== 0) throw new Error('tree not empty')
  process.stderr.write('TREE_EMPTY\n')
  acknowledge()
  process.chdir('..')
  const currentParent = fs.lstatSync('.', { bigint: true })
  const currentRoot = fs.lstatSync(quarantineName, { bigint: true })
  if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino) throw new Error('parent moved')
  if (!currentRoot.isDirectory() || currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino) throw new Error('root moved')
  fs.rmdirSync(quarantineName)
  fs.fsyncSync(parent)
  process.stdout.write(JSON.stringify({ removed: true }))
} catch {
  process.stdout.write(JSON.stringify({ removed: false }))
  process.exitCode = 1
} finally {
  if (root !== undefined) try { fs.closeSync(root) } catch {}
  if (parent !== undefined) try { fs.closeSync(parent) } catch {}
}
`

export interface RetentionPoint {
  id: string
  completedAt: string
  health: PointHealth | 'incomplete'
  estimatedBytes: number
  protected: boolean
  identity?: string
}

export interface RetentionDecision extends RetentionPoint {
  action: 'keep' | 'remove'
  reason:
    | 'recent-healthy'
    | 'expired-healthy'
    | 'last-healthy'
    | 'protected-safety-point'
    | 'non-healthy-not-counted'
    | 'malformed-not-cleaned'
}

export interface RetentionPlan {
  healthyRetention: number
  pointSetFingerprint: string
  decisions: RetentionDecision[]
  kept: RetentionDecision[]
  removed: RetentionDecision[]
  estimatedBytesRemoved: number
}

export interface RetentionResult extends RetentionPlan {
  operation: 'retention'
  dryRun: boolean
  repositoryId: string
  state: OperationState
  category: OperationCategory
  startedAt: string
  endedAt: string
  deletedPointIds: string[]
  issues: ClassifiedIssue[]
}

export interface ExecuteV1RetentionOptions {
  repositoryPath: string
  expectedRepositoryId: string
  expectedProtection: ProtectionMode
  credentialProvider?: CredentialProvider
  healthyRetention?: number
  dryRun: boolean
  protectedPointIds?: Iterable<string>
  isPointProtected?: (pointId: string) => boolean | Promise<boolean>
  now?: () => Date
  beforeDriftCheck?: (plan: RetentionPlan) => void | Promise<void>
  onDeleteWorkerCwdBound?: (quarantinePath: string) => void | Promise<void>
  deletePoint?: (repository: RepositoryHandle, point: DiscoveredPoint) => Promise<void>
  acquireLock?: (repository: RepositoryHandle, operation: string) => Promise<RepositoryLock>
}

function compareNewest(left: RetentionPoint, right: RetentionPoint): number {
  return (
    Date.parse(right.completedAt) - Date.parse(left.completedAt) || right.id.localeCompare(left.id)
  )
}

function fingerprint(points: readonly RetentionPoint[]): string {
  return points
    .map(
      (point) =>
        `${point.id}\0${point.completedAt}\0${point.health}\0${point.protected ? 1 : 0}\0${point.identity ?? ''}`,
    )
    .sort()
    .join('\n')
}

export function planV1Retention(
  input: readonly RetentionPoint[],
  healthyRetention = DEFAULT_HEALTHY_RETENTION,
): RetentionPlan {
  if (!Number.isSafeInteger(healthyRetention) || healthyRetention < 1) {
    throw new Error('Healthy retention must be an integer of at least one')
  }
  const points = [...input].sort(compareNewest)
  if (new Set(points.map((point) => point.id)).size !== points.length) {
    throw new Error('Retention input contains duplicate recovery point IDs')
  }
  const healthy = points.filter((point) => point.health === 'healthy' && !point.protected)
  const recent = new Set(healthy.slice(0, healthyRetention).map((point) => point.id))
  const allHealthy = points.filter((point) => point.health === 'healthy')
  const lastHealthy = allHealthy.length === 1 ? allHealthy[0]?.id : undefined
  const decisions: RetentionDecision[] = points.map((point) => {
    if (point.protected) {
      return { ...point, action: 'keep', reason: 'protected-safety-point' }
    }
    if (point.health !== 'healthy') {
      return {
        ...point,
        action: 'keep',
        reason: point.health === 'incomplete' ? 'malformed-not-cleaned' : 'non-healthy-not-counted',
      }
    }
    if (point.id === lastHealthy) return { ...point, action: 'keep', reason: 'last-healthy' }
    if (recent.has(point.id)) return { ...point, action: 'keep', reason: 'recent-healthy' }
    return { ...point, action: 'remove', reason: 'expired-healthy' }
  })
  const kept = decisions.filter((point) => point.action === 'keep')
  const removed = decisions.filter((point) => point.action === 'remove')
  return {
    healthyRetention,
    pointSetFingerprint: fingerprint(points),
    decisions,
    kept,
    removed,
    estimatedBytesRemoved: removed.reduce((total, point) => total + point.estimatedBytes, 0),
  }
}

async function estimatePointBytes(path: string): Promise<number> {
  let bytes = 0
  let entries = 0
  const queue = [path]
  while (queue.length > 0) {
    const current = queue.shift() as string
    const directory = await opendir(current)
    try {
      for await (const entry of directory) {
        entries++
        if (entries > MAX_ESTIMATE_ENTRIES) throw new Error('point tree too large')
        const child = join(current, entry.name)
        const metadata = await lstat(child)
        if (metadata.isSymbolicLink()) throw new Error('unsafe point tree')
        if (metadata.isDirectory()) queue.push(child)
        else if (metadata.isFile()) bytes += metadata.size
        else throw new Error('unsafe point tree')
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
  }
  return bytes
}

export async function deleteV1PointSafely(
  repository: RepositoryHandle,
  point: DiscoveredPoint,
  options: { onCwdBound?: (quarantinePath: string) => void | Promise<void> } = {},
): Promise<void> {
  const parent = await lstat(repository.layout.points, { bigint: true })
  const current = await lstat(point.path, { bigint: true })
  if (
    !parent.isDirectory() ||
    !current.isDirectory() ||
    current.dev !== point.device ||
    current.ino !== point.inode
  ) {
    throw new Error('Recovery point identity changed before deletion')
  }
  const quarantine = `${point.id}.retention-${randomUUID()}`
  const quarantinePath = join(repository.layout.points, quarantine)
  const output = await new Promise<string>((resolve) => {
    execFile(
      process.execPath,
      [
        '-e',
        DIRECTORY_BOUND_QUARANTINE_WORKER,
        point.id,
        quarantine,
        parent.dev.toString(),
        parent.ino.toString(),
        point.device.toString(),
        point.inode.toString(),
      ],
      {
        cwd: repository.layout.points,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: MAX_WORKER_OUTPUT,
        windowsHide: true,
      },
      (_error, stdout) => resolve(stdout),
    )
  })
  let quarantineResult: { quarantined?: unknown; device?: unknown; inode?: unknown }
  try {
    quarantineResult = JSON.parse(output) as typeof quarantineResult
  } catch {
    throw new Error('Directory-bound recovery point quarantine acknowledgement was invalid')
  }
  if (
    quarantineResult.quarantined !== true ||
    typeof quarantineResult.device !== 'string' ||
    typeof quarantineResult.inode !== 'string'
  ) {
    throw new Error('Directory-bound recovery point quarantine failed')
  }
  const quarantined = await lstat(quarantinePath, { bigint: true }).catch(() => undefined)
  const currentParent = await lstat(repository.layout.points, { bigint: true }).catch(
    () => undefined,
  )
  if (
    !quarantined?.isDirectory() ||
    quarantined.dev !== point.device ||
    quarantined.ino !== point.inode ||
    quarantineResult.device !== point.device.toString() ||
    quarantineResult.inode !== point.inode.toString() ||
    !currentParent?.isDirectory() ||
    currentParent.dev !== parent.dev ||
    currentParent.ino !== parent.ino
  ) {
    throw new Error('Quarantined recovery point identity is ambiguous')
  }

  const removed = await runPhysicalDeleteWorker(
    repository.layout.points,
    quarantinePath,
    quarantine,
    { device: point.device, inode: point.inode },
    { device: parent.dev, inode: parent.ino },
    options.onCwdBound,
  )
  if (!removed) throw new Error('Directory-bound recovery point deletion failed')

  let quarantineStillExists = true
  try {
    await lstat(quarantinePath, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    quarantineStillExists = false
  }
  const finalParent = await lstat(repository.layout.points, { bigint: true }).catch(() => undefined)
  if (
    quarantineStillExists ||
    !finalParent?.isDirectory() ||
    finalParent.dev !== parent.dev ||
    finalParent.ino !== parent.ino
  ) {
    throw new Error('Recovery point deletion acknowledgement was ambiguous')
  }
}

async function runPhysicalDeleteWorker(
  pointsPath: string,
  quarantinePath: string,
  quarantineName: string,
  root: { device: bigint; inode: bigint },
  parent: { device: bigint; inode: bigint },
  onCwdBound?: (quarantinePath: string) => void | Promise<void>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        PHYSICAL_DELETE_WORKER,
        quarantineName,
        root.device.toString(),
        root.inode.toString(),
        parent.device.toString(),
        parent.inode.toString(),
      ],
      {
        cwd: quarantinePath,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const control = child.stdio[3]
    let stdoutBytes = 0
    let stderrBytes = 0
    let cwdAcknowledged = false
    let emptyAcknowledged = false
    let cwdAcknowledging = false
    let emptyAcknowledging = false
    let failed = false
    const timeout = setTimeout(() => {
      failed = true
      child.kill('SIGKILL')
    }, 35_000)
    timeout.unref()

    const abort = (): void => {
      failed = true
      if (control && 'destroy' in control) control.destroy()
      child.kill('SIGKILL')
    }
    const assertPathIdentity = async (): Promise<void> => {
      const [currentRoot, currentParent] = await Promise.all([
        lstat(quarantinePath, { bigint: true }),
        lstat(pointsPath, { bigint: true }),
      ])
      if (
        !currentRoot.isDirectory() ||
        currentRoot.dev !== root.device ||
        currentRoot.ino !== root.inode ||
        !currentParent.isDirectory() ||
        currentParent.dev !== parent.device ||
        currentParent.ino !== parent.inode
      ) {
        throw new Error('delete path identity changed')
      }
    }
    const acknowledge = async (phase: 'cwd' | 'empty'): Promise<void> => {
      if (phase === 'cwd') await onCwdBound?.(quarantinePath)
      await assertPathIdentity()
      if (!control || !('write' in control)) throw new Error('control unavailable')
      control.write(Buffer.from([1]))
      if (phase === 'cwd') cwdAcknowledged = true
      else {
        emptyAcknowledged = true
        control.end()
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_WORKER_OUTPUT) return abort()
      stdout.push(Buffer.from(chunk))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_WORKER_OUTPUT) return abort()
      stderr.push(Buffer.from(chunk))
      const diagnostics = Buffer.concat(stderr, stderrBytes).toString('ascii')
      if (!cwdAcknowledged && !cwdAcknowledging && diagnostics.includes('CWD_BOUND\n')) {
        cwdAcknowledging = true
        void acknowledge('cwd').catch(abort)
      } else if (
        cwdAcknowledged &&
        !emptyAcknowledged &&
        !emptyAcknowledging &&
        diagnostics.includes('TREE_EMPTY\n')
      ) {
        emptyAcknowledging = true
        void acknowledge('empty').catch(abort)
      }
    })
    child.once('error', abort)
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (control && 'destroy' in control) control.destroy()
      if (failed || code !== 0 || signal !== null || !cwdAcknowledged || !emptyAcknowledged) {
        resolve(false)
        return
      }
      try {
        resolve(
          (
            JSON.parse(Buffer.concat(stdout, stdoutBytes).toString('utf8')) as {
              removed?: unknown
            }
          ).removed === true,
        )
      } catch {
        resolve(false)
      }
    })
  })
}

async function inventory(
  repository: RepositoryHandle,
  options: ExecuteV1RetentionOptions,
): Promise<{ points: RetentionPoint[]; discovered: Map<string, DiscoveredPoint> }> {
  const discovery = await discoverVisiblePoints(repository)
  const report = await verifyV1Repository({
    repositoryPath: options.repositoryPath,
    expectedRepositoryId: options.expectedRepositoryId,
    expectedProtection: options.expectedProtection,
    ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
    selector: { kind: 'all' },
    scope: 'structural',
  })
  const resultById = new Map(report.points.map((point) => [point.pointId, point]))
  const protectedIds = new Set(options.protectedPointIds ?? [])
  const points: RetentionPoint[] = []
  for (const point of discovery.points) {
    const result = resultById.get(point.id)
    const protectedPoint =
      protectedIds.has(point.id) || Boolean(await options.isPointProtected?.(point.id))
    let estimatedBytes = 0
    let estimateSafe = true
    try {
      estimatedBytes = await estimatePointBytes(point.path)
    } catch {
      estimateSafe = false
    }
    points.push({
      id: point.id,
      completedAt: point.descriptor.completedAt,
      health:
        estimateSafe && result?.structurallyHealthy && result.manifestHealth === 'healthy'
          ? 'healthy'
          : result?.manifestHealth === 'partial'
            ? 'partial'
            : 'failed',
      estimatedBytes,
      protected: protectedPoint,
      identity: `${point.device}:${point.inode}`,
    })
  }
  for (const malformed of discovery.diagnostics) {
    points.push({
      id: malformed.pointId ?? malformed.name,
      completedAt: '1970-01-01T00:00:00.000Z',
      health: 'incomplete',
      estimatedBytes: 0,
      protected: true,
    })
  }
  return { points, discovered: new Map(discovery.points.map((point) => [point.id, point])) }
}

function retentionIssue(
  code: string,
  category: ClassifiedIssue['category'],
  message: string,
): ClassifiedIssue {
  return {
    code,
    category,
    message,
    nextAction: 'Inspect repository status and retry retention safely',
  }
}

function safeNow(now?: () => Date): Date {
  const value = now?.() ?? new Date()
  if (!Number.isFinite(value.getTime())) throw new Error('invalid time')
  return value
}

function emptyPlan(healthyRetention: number): RetentionPlan {
  return planV1Retention([], healthyRetention)
}

export async function executeV1Retention(
  options: ExecuteV1RetentionOptions,
): Promise<RetentionResult> {
  const started = safeNow(options.now)
  const healthyRetention = options.healthyRetention ?? DEFAULT_HEALTHY_RETENTION
  let repository: RepositoryHandle | undefined
  let lock: RepositoryLock | undefined
  let plan = emptyPlan(
    Number.isSafeInteger(healthyRetention) && healthyRetention >= 1
      ? healthyRetention
      : DEFAULT_HEALTHY_RETENTION,
  )
  const deletedPointIds: string[] = []
  const issues: ClassifiedIssue[] = []
  let category: OperationCategory = 'success'
  let deletionAttempted = false
  let lockReleaseFailed = false
  try {
    if (!Number.isSafeInteger(healthyRetention) || healthyRetention < 1) {
      throw new RepositoryError(
        'configuration',
        'INVALID_RETENTION_LIMIT',
        'Healthy retention must be an integer of at least one',
      )
    }
    repository = await openRepository(options.repositoryPath, {
      intent: options.dryRun ? 'read' : 'write',
      expectedRepositoryId: options.expectedRepositoryId,
      expectedProtection: options.expectedProtection,
      ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
    })
    if (repository.descriptor.protection === 'encrypted' && !repository.protector) {
      throw new RepositoryError(
        'authentication',
        'REPOSITORY_AUTHENTICATION_FAILED',
        'Encrypted repository is locked',
      )
    }
    if (!options.dryRun)
      lock = await (options.acquireLock ?? acquireRepositoryLock)(repository, 'retention')
    const initial = await inventory(repository, options)
    plan = planV1Retention(initial.points, healthyRetention)
    if (!options.dryRun && plan.removed.length > 0) {
      await options.beforeDriftCheck?.(plan)
      const current = await inventory(repository, options)
      if (
        planV1Retention(current.points, healthyRetention).pointSetFingerprint !==
        plan.pointSetFingerprint
      ) {
        throw new RepositoryError(
          'integrity',
          'RETENTION_POINT_DRIFT',
          'Recovery point set changed before deletion',
        )
      }
      for (const decision of plan.removed) {
        const point = current.discovered.get(decision.id)
        if (!point)
          throw new RepositoryError(
            'integrity',
            'RETENTION_POINT_DRIFT',
            'Recovery point disappeared before deletion',
          )
        deletionAttempted = true
        try {
          if (options.deletePoint) await options.deletePoint(repository, point)
          else {
            await deleteV1PointSafely(repository, point, {
              onCwdBound: options.onDeleteWorkerCwdBound,
            })
          }
          deletedPointIds.push(point.id)
        } catch {
          category = 'destination'
          issues.push(
            retentionIssue(
              'RETENTION_DELETE_FAILED',
              'destination',
              'An expired healthy recovery point could not be removed safely',
            ),
          )
        }
      }
    }
  } catch (error) {
    category =
      error instanceof RepositoryError
        ? error.category
        : error instanceof ProtectionError
          ? 'authentication'
          : 'internal'
    issues.push(
      retentionIssue(
        error instanceof RepositoryError
          ? error.code
          : error instanceof ProtectionError
            ? error.code
            : 'RETENTION_FAILED',
        category as ClassifiedIssue['category'],
        error instanceof RepositoryError ? error.message : 'Retention did not complete',
      ),
    )
  }

  try {
    await lock?.release()
  } catch {
    lockReleaseFailed = true
    category = 'lock'
    issues.push(
      retentionIssue('LOCK_RELEASE_FAILED', 'lock', 'Repository lock could not be released'),
    )
  }
  repository?.close()
  const ended = safeNow(options.now)
  const state: OperationState =
    issues.length === 0
      ? 'success'
      : deletionAttempted || lockReleaseFailed
        ? 'degraded'
        : 'failure'
  return {
    operation: 'retention',
    dryRun: options.dryRun,
    repositoryId: options.expectedRepositoryId,
    state,
    category,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    ...plan,
    deletedPointIds,
    issues,
  }
}

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { LEGACY_FORMAT, LEGACY_MAX_FILE_BYTES, LegacyMigrationError } from './types.js'
import type {
  LegacyEntryDescriptor,
  LegacyIssue,
  LegacyRecoveryPointDescriptor,
  LegacyRepositoryDescriptor,
  MigrationSystem,
} from './types.js'

const LEGACY_MARKER_NAME = '.restore-marker'
const LEGACY_MARKER = 'restore-backup-directory\n'
const LEGACY_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})$/
const MAX_TREE_ENTRIES = 100_000
const MAX_DIRECTORY_WORKER_OUTPUT = 64 * 1024 * 1024
const LEGACY_MARKER_HASH = createHash('sha256').update(LEGACY_MARKER).digest('hex')
const execFileAsync = promisify(execFile)
const DIRECTORY_BOUND_SCAN_WORKER = String.raw`
const fs = require('node:fs')
const crypto = require('node:crypto')
const [expectedDev, expectedIno, expectedMtime, expectedCtime, maximumValue, maxFileValue] = process.argv.slice(1)
const maximum = Number(maximumValue)
const maxFile = BigInt(maxFileValue)
let held
let directory
try {
  held = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY)
  const before = fs.fstatSync(held, { bigint: true })
  if (!before.isDirectory() || before.dev !== BigInt(expectedDev) || before.ino !== BigInt(expectedIno) || before.mtimeNs !== BigInt(expectedMtime) || before.ctimeNs !== BigInt(expectedCtime)) throw new Error('directory mismatch')
  directory = fs.opendirSync('.')
  const entries = []
  for (;;) {
    const item = directory.readSync()
    if (!item) break
    if (entries.length >= maximum) throw new Error('entry bound')
    const name = item.name
    const initial = fs.lstatSync(name, { bigint: true })
    const base = {
      name,
      device: initial.dev.toString(),
      inode: initial.ino.toString(),
      mode: initial.mode.toString(),
      size: initial.size.toString(),
      links: initial.nlink.toString(),
      modifiedAtNs: initial.mtimeNs.toString(),
      changedAtNs: initial.ctimeNs.toString(),
    }
    if (initial.isDirectory() && !initial.isSymbolicLink()) {
      entries.push({ ...base, type: 'directory' })
      continue
    }
    if (initial.isSymbolicLink()) {
      entries.push({ ...base, type: 'symlink', linkTarget: fs.readlinkSync(name) })
      continue
    }
    if (!initial.isFile()) {
      entries.push({ ...base, type: 'special' })
      continue
    }
    if (initial.size < 0n || initial.size > maxFile) {
      entries.push({ ...base, type: 'file', tooLarge: true })
      continue
    }
    const file = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const opened = fs.fstatSync(file, { bigint: true })
      const named = fs.lstatSync(name, { bigint: true })
      if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size || named.dev !== initial.dev || named.ino !== initial.ino) throw new Error('file mismatch')
      const content = fs.readFileSync(file)
      const after = fs.fstatSync(file, { bigint: true })
      const namedAfter = fs.lstatSync(name, { bigint: true })
      if (content.length !== Number(initial.size) || after.dev !== initial.dev || after.ino !== initial.ino || after.size !== initial.size || after.mtimeNs !== initial.mtimeNs || after.ctimeNs !== initial.ctimeNs || namedAfter.dev !== initial.dev || namedAfter.ino !== initial.ino || namedAfter.size !== initial.size) throw new Error('file changed')
      const hash = crypto.createHash('sha256').update(content).digest('hex')
      content.fill(0)
      entries.push({ ...base, type: 'file', hash })
    } finally { fs.closeSync(file) }
  }
  const after = fs.fstatSync(held, { bigint: true })
  if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error('directory changed')
  process.stdout.write(JSON.stringify(entries))
} catch (error) { process.stderr.write(error && error.message === 'entry bound' ? 'ENTRY_BOUND' : 'SCAN_FAILED'); process.exitCode = 1 }
finally { if (directory) try { directory.closeSync() } catch {}; if (held !== undefined) try { fs.closeSync(held) } catch {} }
`

interface BoundDirectoryEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'special'
  device: string
  inode: string
  mode: string
  size: string
  links: string
  modifiedAtNs: string
  changedAtNs: string
  hash?: string
  linkTarget?: string
  tooLarge?: true
}

export interface LegacyReadOptions {
  system?: MigrationSystem
  /** Test-only synchronization hook immediately before a directory-bound worker starts. */
  beforeDirectoryScan?: (path: string) => void | Promise<void>
}

interface ScannedEntry extends LegacyEntryDescriptor {
  device: string
  inode: string
  changedAtNs: string
  modifiedAtNs: string
}

interface ScannedTree {
  entries: ScannedEntry[]
  issues: LegacyIssue[]
}

function currentSystem(): MigrationSystem {
  return { platform: platform(), architecture: arch() }
}

export function assertMigrationSystem(system: MigrationSystem = currentSystem()): void {
  if (system.platform !== 'darwin' || system.architecture !== 'arm64') {
    throw new LegacyMigrationError(
      'UNSUPPORTED_PLATFORM',
      'unsupported',
      'Legacy recovery and migration are supported only on Apple Silicon macOS',
    )
  }
}

function invalidName(name: string): boolean {
  const hasControlCharacter = [...name].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
  return (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0') ||
    hasControlCharacter
  )
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
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

async function openStable(path: string, directory: boolean) {
  const handle = await open(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      (directory ? constants.O_DIRECTORY : 0),
  )
  try {
    const held = await handle.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    if ((directory ? !held.isDirectory() : !held.isFile()) || !sameIdentity(held, current)) {
      throw new Error('identity mismatch')
    }
    return { handle, metadata: held }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function assertPathStable(
  path: string,
  handle: Awaited<ReturnType<typeof open>>,
  expected: BigIntStats,
): Promise<void> {
  const held = await handle.stat({ bigint: true })
  const current = await lstat(path, { bigint: true })
  if (!sameIdentity(expected, held) || !sameIdentity(expected, current)) {
    throw new LegacyMigrationError(
      'LEGACY_SOURCE_CHANGED',
      'source',
      'Legacy source identity changed during a read-only operation',
    )
  }
}

function issue(
  code: string,
  message: string,
  relativePath: string,
  category: LegacyIssue['category'] = 'unsupported',
): LegacyIssue {
  return { code, category, message, relativePath }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function validDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value)
}

async function scanBoundDirectory(
  path: string,
  expected: { device: string; inode: string; modifiedAtNs: string; changedAtNs: string },
  maximum: number,
  beforeScan?: (path: string) => void | Promise<void>,
): Promise<BoundDirectoryEntry[]> {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_TREE_ENTRIES) {
    throw new LegacyMigrationError(
      'LEGACY_TREE_TOO_LARGE',
      'unsupported',
      'Legacy directory exceeds the bounded entry count',
    )
  }
  let stdout: string
  try {
    await beforeScan?.(path)
    const result = await execFileAsync(
      process.execPath,
      [
        '-e',
        DIRECTORY_BOUND_SCAN_WORKER,
        expected.device,
        expected.inode,
        expected.modifiedAtNs,
        expected.changedAtNs,
        maximum.toString(),
        LEGACY_MAX_FILE_BYTES.toString(),
      ],
      {
        cwd: path,
        encoding: 'utf8',
        maxBuffer: MAX_DIRECTORY_WORKER_OUTPUT,
        windowsHide: true,
      },
    )
    stdout = result.stdout
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'stderr' in error &&
      String(error.stderr).includes('ENTRY_BOUND')
    ) {
      throw new LegacyMigrationError(
        'LEGACY_TREE_TOO_LARGE',
        'unsupported',
        'Legacy directory exceeds the bounded entry count',
      )
    }
    throw new LegacyMigrationError(
      'LEGACY_SOURCE_CHANGED',
      'source',
      error instanceof LegacyMigrationError
        ? error.message
        : 'Legacy directory could not be enumerated through its held identity',
    )
  }
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new LegacyMigrationError(
      'LEGACY_DIRECTORY_UNREADABLE',
      'source',
      'Legacy directory worker returned malformed metadata',
    )
  }
  if (!Array.isArray(value) || value.length > maximum) {
    throw new LegacyMigrationError(
      'LEGACY_TREE_TOO_LARGE',
      'unsupported',
      'Legacy directory exceeds the bounded entry count',
    )
  }
  const entries: BoundDirectoryEntry[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new LegacyMigrationError(
        'LEGACY_DIRECTORY_UNREADABLE',
        'source',
        'Legacy directory worker returned invalid entry metadata',
      )
    }
    const candidate = item as Partial<BoundDirectoryEntry>
    if (
      typeof candidate.name !== 'string' ||
      !['file', 'directory', 'symlink', 'special'].includes(candidate.type ?? '') ||
      !validDecimal(candidate.device) ||
      !validDecimal(candidate.inode) ||
      !validDecimal(candidate.mode) ||
      !validDecimal(candidate.size) ||
      !validDecimal(candidate.links) ||
      !validDecimal(candidate.modifiedAtNs) ||
      !validDecimal(candidate.changedAtNs) ||
      (candidate.hash !== undefined && !/^[0-9a-f]{64}$/.test(candidate.hash)) ||
      (candidate.linkTarget !== undefined && typeof candidate.linkTarget !== 'string') ||
      (candidate.tooLarge !== undefined && candidate.tooLarge !== true)
    ) {
      throw new LegacyMigrationError(
        'LEGACY_DIRECTORY_UNREADABLE',
        'source',
        'Legacy directory worker returned invalid entry metadata',
      )
    }
    entries.push(candidate as BoundDirectoryEntry)
  }
  return entries.sort((left, right) => compareText(left.name, right.name))
}

function symlinkIssue(path: string, relativePath: string, target: string): LegacyIssue {
  const resolvedTarget = resolve(dirname(path), target)
  const root = resolve(path, ...relativePath.split('/').map(() => '..'))
  const escaped =
    isAbsolute(target) ||
    (relative(resolvedTarget.startsWith(root) ? root : root, resolvedTarget).startsWith('..') &&
      !resolvedTarget.startsWith(`${root}${sep}`))
  return escaped
    ? issue(
        'LEGACY_SYMLINK_ESCAPE',
        'Legacy symbolic link escapes its recovery point and cannot be recovered safely',
        relativePath,
      )
    : issue(
        'LEGACY_SYMLINK_UNSUPPORTED',
        'Legacy symbolic links are not part of the 0.1.x regular-file contract',
        relativePath,
      )
}

function boundDirectoryFromStats(name: string, metadata: BigIntStats): BoundDirectoryEntry {
  return {
    name,
    type: 'directory',
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    mode: metadata.mode.toString(),
    size: metadata.size.toString(),
    links: metadata.nlink.toString(),
    modifiedAtNs: metadata.mtimeNs.toString(),
    changedAtNs: metadata.ctimeNs.toString(),
  }
}

async function scanTree(
  rootPath: string,
  rootMetadata: BoundDirectoryEntry,
  options: LegacyReadOptions,
): Promise<ScannedTree> {
  const entries: ScannedEntry[] = []
  const issues: LegacyIssue[] = []
  const queue: Array<{
    path: string
    relativePath: string
    metadata: BoundDirectoryEntry
  }> = [{ path: rootPath, relativePath: '', metadata: rootMetadata }]
  let observedEntries = 0

  for (let index = 0; index < queue.length; index++) {
    if (observedEntries > MAX_TREE_ENTRIES) {
      throw new LegacyMigrationError(
        'LEGACY_TREE_TOO_LARGE',
        'unsupported',
        'Legacy recovery point exceeds the bounded entry count',
      )
    }
    const directory = queue[index]
    if (directory.relativePath) {
      entries.push({
        relativePath: directory.relativePath,
        type: 'directory',
        size: Number(BigInt(directory.metadata.size)),
        device: directory.metadata.device,
        inode: directory.metadata.inode,
        changedAtNs: directory.metadata.changedAtNs,
        modifiedAtNs: directory.metadata.modifiedAtNs,
        mode: Number(BigInt(directory.metadata.mode) & 0o7777n),
      })
    }
    const children = await scanBoundDirectory(
      directory.path,
      directory.metadata,
      MAX_TREE_ENTRIES - observedEntries,
      options.beforeDirectoryScan,
    )
    for (const child of children) {
      observedEntries++
      const relativePath = directory.relativePath
        ? `${directory.relativePath}/${child.name}`
        : child.name
      if (invalidName(child.name)) {
        issues.push(
          issue(
            'LEGACY_MALFORMED_NAME',
            'Legacy entry name is malformed or contains control characters',
            relativePath,
          ),
        )
        continue
      }
      const path = join(directory.path, child.name)
      if (child.type === 'directory') {
        queue.push({ path, relativePath, metadata: child })
        continue
      }
      if (child.type === 'file') {
        if (child.tooLarge || !child.hash) {
          issues.push(
            issue(
              'LEGACY_FILE_TOO_LARGE',
              'Legacy file exceeds the v1 64 MiB per-file capture limit',
              relativePath,
            ),
          )
          continue
        }
        entries.push({
          relativePath,
          type: 'file',
          size: Number(BigInt(child.size)),
          contentHash: child.hash,
          device: child.device,
          inode: child.inode,
          changedAtNs: child.changedAtNs,
          modifiedAtNs: child.modifiedAtNs,
          mode: Number(BigInt(child.mode) & 0o7777n),
        })
        continue
      }
      if (child.type === 'symlink') {
        issues.push(symlinkIssue(path, relativePath, child.linkTarget ?? ''))
        continue
      }
      issues.push(
        issue(
          'LEGACY_SPECIAL_NODE_UNSUPPORTED',
          'Legacy special filesystem nodes cannot be recovered or migrated',
          relativePath,
        ),
      )
    }
  }
  entries.sort((left, right) => compareText(left.relativePath, right.relativePath))
  issues.sort((left, right) => compareText(left.relativePath ?? '', right.relativePath ?? ''))
  return { entries, issues }
}

function timestampDate(name: string): string | undefined {
  const match = LEGACY_TIMESTAMP.exec(name)
  if (!match) return undefined
  const parsed = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  if (!Number.isFinite(parsed.getTime())) return undefined
  const emitted = parsed.toISOString().replace(/:/g, '-').replace('Z', '')
  return emitted === name ? parsed.toISOString() : undefined
}

function logicalDigest(entries: readonly ScannedEntry[], issues: readonly LegacyIssue[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        entries: entries.map(
          ({ device: _device, inode: _inode, changedAtNs: _changed, ...entry }) => entry,
        ),
        issues,
      }),
    )
    .digest('hex')
}

function identityDigest(entries: readonly ScannedEntry[], root: BoundDirectoryEntry): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        root: {
          device: root.device,
          inode: root.inode,
          changedAtNs: root.changedAtNs,
          modifiedAtNs: root.modifiedAtNs,
          mode: root.mode,
        },
        entries: entries.map((entry) => ({
          relativePath: entry.relativePath,
          device: entry.device,
          inode: entry.inode,
          changedAtNs: entry.changedAtNs,
          modifiedAtNs: entry.modifiedAtNs,
          mode: entry.mode,
          size: entry.size,
        })),
      }),
    )
    .digest('hex')
}

function readMarker(entry: BoundDirectoryEntry | undefined): {
  device: string
  inode: string
  changedAtNs: string
  modifiedAtNs: string
  mode: string
} {
  if (
    !entry ||
    entry.type !== 'file' ||
    entry.tooLarge ||
    entry.size !== Buffer.byteLength(LEGACY_MARKER).toString() ||
    entry.hash !== LEGACY_MARKER_HASH
  ) {
    throw new LegacyMigrationError(
      'NOT_LEGACY_REPOSITORY',
      'integrity',
      'Legacy repository marker is missing, unsafe, or invalid',
    )
  }
  return {
    device: entry.device,
    inode: entry.inode,
    changedAtNs: entry.changedAtNs,
    modifiedAtNs: entry.modifiedAtNs,
    mode: entry.mode,
  }
}

export async function readLegacyRepository(
  repositoryPath: string,
  options: LegacyReadOptions = {},
): Promise<LegacyRepositoryDescriptor> {
  assertMigrationSystem(options.system)
  let rootPath: string
  let root: Awaited<ReturnType<typeof openStable>>
  try {
    const requestedPath = resolve(repositoryPath)
    const requested = await lstat(requestedPath, { bigint: true })
    if (!requested.isDirectory() || requested.isSymbolicLink()) throw new Error('unsafe root')
    rootPath = await realpath(requestedPath)
    root = await openStable(rootPath, true)
  } catch {
    throw new LegacyMigrationError(
      'NOT_LEGACY_REPOSITORY',
      'integrity',
      'Legacy repository root is missing, linked, or not a directory',
    )
  }
  try {
    const points: LegacyRecoveryPointDescriptor[] = []
    const unsupported: LegacyIssue[] = []
    const rootBound = boundDirectoryFromStats('', root.metadata)
    const children = await scanBoundDirectory(
      rootPath,
      rootBound,
      MAX_TREE_ENTRIES,
      options.beforeDirectoryScan,
    )
    const markerIdentity = readMarker(children.find((entry) => entry.name === LEGACY_MARKER_NAME))
    await assertPathStable(rootPath, root.handle, root.metadata)
    for (const child of children) {
      if (child.name === LEGACY_MARKER_NAME) continue
      const createdAt = timestampDate(child.name)
      const relativePath = child.name
      if (!createdAt) {
        unsupported.push(
          issue(
            child.name.endsWith('.in-progress')
              ? 'LEGACY_INCOMPLETE_POINT'
              : 'LEGACY_UNKNOWN_ROOT_ENTRY',
            child.name.endsWith('.in-progress')
              ? 'Incomplete legacy recovery point is not visible or migratable'
              : 'Unknown legacy repository entry is outside the 0.1.x format',
            relativePath,
          ),
        )
        continue
      }
      const pointPath = join(rootPath, child.name)
      if (child.type !== 'directory') {
        unsupported.push(
          issue(
            'LEGACY_POINT_NOT_DIRECTORY',
            'Legacy recovery point is not a no-follow directory',
            relativePath,
          ),
        )
        continue
      }
      const tree = await scanTree(pointPath, child, options)
      const fileEntries = tree.entries.filter((entry) => entry.type === 'file')
      const totalBytes = fileEntries.reduce((total, entry) => total + entry.size, 0)
      const digest = logicalDigest(tree.entries, tree.issues)
      points.push({
        id: child.name,
        path: pointPath,
        createdAt,
        digest,
        identityDigest: identityDigest(tree.entries, child),
        fileCount: fileEntries.length,
        directoryCount: tree.entries.length - fileEntries.length,
        totalBytes,
        migratable: tree.issues.length === 0,
        entries: tree.entries.map(
          ({ device: _device, inode: _inode, changedAtNs: _changed, ...entry }) => entry,
        ),
        unsupported: tree.issues,
      })
    }
    await assertPathStable(rootPath, root.handle, root.metadata)
    points.sort((left, right) => compareText(right.createdAt, left.createdAt))
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          format: LEGACY_FORMAT,
          points: points.map((point) => ({ id: point.id, digest: point.digest })),
          unsupported,
        }),
      )
      .digest('hex')
    const physicalDigest = createHash('sha256')
      .update(
        JSON.stringify({
          root: {
            device: root.metadata.dev.toString(),
            inode: root.metadata.ino.toString(),
            changedAtNs: root.metadata.ctimeNs.toString(),
          },
          marker: markerIdentity,
          points: points.map((point) => ({ id: point.id, digest: point.identityDigest })),
        }),
      )
      .digest('hex')
    return {
      format: LEGACY_FORMAT,
      compatibility: '0.1.x',
      rootPath,
      marker: 'restore-backup-directory',
      readOnly: true,
      identity: {
        device: root.metadata.dev.toString(),
        inode: root.metadata.ino.toString(),
        changedAtNs: root.metadata.ctimeNs.toString(),
      },
      digest,
      identityDigest: physicalDigest,
      points,
      unsupported,
    }
  } finally {
    await root.handle.close().catch(() => undefined)
  }
}

export function assertLegacySourceUnchanged(
  before: LegacyRepositoryDescriptor,
  after: LegacyRepositoryDescriptor,
): void {
  if (
    before.rootPath !== after.rootPath ||
    before.digest !== after.digest ||
    before.identityDigest !== after.identityDigest ||
    before.identity.device !== after.identity.device ||
    before.identity.inode !== after.identity.inode
  ) {
    throw new LegacyMigrationError(
      'LEGACY_SOURCE_CHANGED',
      'source',
      'Legacy source content or identity changed during a read-only operation',
    )
  }
}

export async function detectLegacyRepository(
  repositoryPath: string,
  options: LegacyReadOptions = {},
): Promise<LegacyRepositoryDescriptor | null> {
  try {
    return await readLegacyRepository(repositoryPath, options)
  } catch (error) {
    if (error instanceof LegacyMigrationError && error.code === 'NOT_LEGACY_REPOSITORY') return null
    throw error
  }
}

export async function isLegacyRepository(
  repositoryPath: string,
  options: LegacyReadOptions = {},
): Promise<boolean> {
  return (await detectLegacyRepository(repositoryPath, options)) !== null
}

export async function listLegacyRecoveryPoints(
  repositoryPath: string,
  options: LegacyReadOptions = {},
): Promise<LegacyRecoveryPointDescriptor[]> {
  const before = await readLegacyRepository(repositoryPath, options)
  const points = before.points.map((point) => ({
    ...point,
    entries: point.entries.map((entry) => ({ ...entry })),
    unsupported: point.unsupported.map((entry) => ({ ...entry })),
  }))
  const after = await readLegacyRepository(repositoryPath, options)
  assertLegacySourceUnchanged(before, after)
  return points
}

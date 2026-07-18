import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const MAX_RECOVERY_FILE_BYTES = 64 * 1024 * 1024
const MAX_WORKER_OUTPUT = 8192
const DIRECTORY_BOUND_READ_WORKER = String.raw`
const fs = require('node:fs')
const [name, parentDev, parentIno, maximum] = process.argv.slice(1)
let parent
let file
try {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error('bad name')
  parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const held = fs.fstatSync(parent, { bigint: true })
  if (held.dev !== BigInt(parentDev) || held.ino !== BigInt(parentIno)) throw new Error('parent mismatch')
  file = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  const stat = fs.fstatSync(file, { bigint: true })
  const current = fs.lstatSync(name, { bigint: true })
  const limit = Number(maximum)
  if (!stat.isFile() || stat.dev !== current.dev || stat.ino !== current.ino || stat.size !== current.size || stat.size > BigInt(limit)) throw new Error('unsafe file')
  const content = fs.readFileSync(file)
  if (content.length > limit) throw new Error('file too large')
  const after = fs.fstatSync(file, { bigint: true })
  const currentAfter = fs.lstatSync(name, { bigint: true })
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs || currentAfter.dev !== stat.dev || currentAfter.ino !== stat.ino || currentAfter.size !== stat.size) throw new Error('file changed during read')
  process.stdout.write(content)
  content.fill(0)
} catch { process.exitCode = 1 }
finally { if (file !== undefined) try { fs.closeSync(file) } catch {}; if (parent !== undefined) try { fs.closeSync(parent) } catch {} }
`
const DIRECTORY_BOUND_MKDIR_WORKER = String.raw`
const fs = require('node:fs')
const [name, parentDev, parentIno] = process.argv.slice(1)
let parent
try {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error('bad name')
  parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const held = fs.fstatSync(parent, { bigint: true })
  if (held.dev !== BigInt(parentDev) || held.ino !== BigInt(parentIno)) throw new Error('parent mismatch')
  let current
  try { current = fs.lstatSync(name, { bigint: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!current) { fs.mkdirSync(name, { mode: 0o700 }); fs.fsyncSync(parent); current = fs.lstatSync(name, { bigint: true }) }
  if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('not directory')
  process.stdout.write(JSON.stringify({ ok: true, device: current.dev.toString(), inode: current.ino.toString() }))
} catch { process.stdout.write(JSON.stringify({ ok: false })); process.exitCode = 1 }
finally { if (parent !== undefined) try { fs.closeSync(parent) } catch {} }
`
const DIRECTORY_BOUND_ENSURE_WORKER = String.raw`
const fs = require('node:fs')
const [name, parentPath, parentDev, parentIno, expectation, targetDev, targetIno, outputMode] = process.argv.slice(1)
let parent
let mutated = false
try {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || !['absent','present'].includes(expectation)) throw new Error('bad input')
  parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const held = fs.fstatSync(parent, { bigint: true })
  if (held.dev !== BigInt(parentDev) || held.ino !== BigInt(parentIno)) throw new Error('parent mismatch')
  const namedParent = fs.lstatSync(parentPath, { bigint: true })
  if (!namedParent.isDirectory() || namedParent.dev !== held.dev || namedParent.ino !== held.ino) throw new Error('parent path mismatch')
  let current
  try { current = fs.lstatSync(name, { bigint: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (expectation === 'present') {
    if (!current || !current.isDirectory() || current.isSymbolicLink() || current.dev !== BigInt(targetDev) || current.ino !== BigInt(targetIno)) throw new Error('directory changed')
  } else {
    if (current) throw new Error('directory appeared')
    const reboundParent = fs.lstatSync(parentPath, { bigint: true })
    if (!reboundParent.isDirectory() || reboundParent.dev !== held.dev || reboundParent.ino !== held.ino) throw new Error('parent path changed')
    fs.mkdirSync(name, { mode: 0o700 })
    mutated = true
    fs.fsyncSync(parent)
    current = fs.lstatSync(name, { bigint: true })
  }
  if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('not directory')
  const finalParent = fs.lstatSync(parentPath, { bigint: true })
  if (!finalParent.isDirectory() || finalParent.dev !== held.dev || finalParent.ino !== held.ino) throw new Error('parent path changed')
  if (outputMode === 'crash-after-mutation' && mutated) throw new Error('simulated post-mutation crash')
  if (outputMode === 'malformed') process.stdout.write('{')
  else if (outputMode !== 'suppress') process.stdout.write(JSON.stringify({ ok: true, device: current.dev.toString(), inode: current.ino.toString() }))
} catch { process.stdout.write(JSON.stringify({ ok: false, phase: mutated ? 'post-mutation' : 'precondition' })); process.exitCode = 1 }
finally { if (parent !== undefined) try { fs.closeSync(parent) } catch {} }
`
const DIRECTORY_BOUND_RENAME_WORKER = String.raw`
const fs = require('node:fs')
const [from, to, parentDev, parentIno, sourceDev, sourceIno, outputMode] = process.argv.slice(1)
let parent
try {
  if ([from,to].some((name) => !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0'))) throw new Error('bad name')
  parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const held = fs.fstatSync(parent, { bigint: true })
  if (held.dev !== BigInt(parentDev) || held.ino !== BigInt(parentIno)) throw new Error('parent mismatch')
  const source = fs.lstatSync(from, { bigint: true })
  if (!source.isDirectory() || source.dev !== BigInt(sourceDev) || source.ino !== BigInt(sourceIno)) throw new Error('source mismatch')
  try { fs.lstatSync(to); throw new Error('destination exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  fs.renameSync(from, to)
  fs.fsyncSync(parent)
  const final = fs.lstatSync(to, { bigint: true })
  if (!final.isDirectory() || final.dev !== source.dev || final.ino !== source.ino) throw new Error('final mismatch')
  if (outputMode === 'malformed') process.stdout.write('{')
  else if (outputMode !== 'suppress') process.stdout.write(JSON.stringify({ ok: true, device: final.dev.toString(), inode: final.ino.toString() }))
} catch { process.stdout.write(JSON.stringify({ ok: false })); process.exitCode = 1 }
finally { if (parent !== undefined) try { fs.closeSync(parent) } catch {} }
`
const DIRECTORY_BOUND_DELETE_WORKER = String.raw`
const fs = require('node:fs')
const [name, parentPath, parentDev, parentIno, targetDev, targetIno, kind] = process.argv.slice(1)
let parent
try {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || !['file','symlink','directory'].includes(kind)) throw new Error('bad input')
  parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const held = fs.fstatSync(parent, { bigint: true })
  if (held.dev !== BigInt(parentDev) || held.ino !== BigInt(parentIno)) throw new Error('parent mismatch')
  const namedParent = fs.lstatSync(parentPath, { bigint: true })
  if (!namedParent.isDirectory() || namedParent.dev !== held.dev || namedParent.ino !== held.ino) throw new Error('parent path mismatch')
  const target = fs.lstatSync(name, { bigint: true })
  const actualKind = target.isSymbolicLink() ? 'symlink' : target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'special'
  if (target.dev !== BigInt(targetDev) || target.ino !== BigInt(targetIno) || actualKind !== kind) throw new Error('target mismatch')
  if (kind === 'directory') fs.rmdirSync(name)
  else fs.unlinkSync(name)
  fs.fsyncSync(parent)
  try { fs.lstatSync(name); throw new Error('target remains') } catch (error) { if (error.code !== 'ENOENT') throw error }
  process.stdout.write(JSON.stringify({ ok: true }))
} catch { process.stdout.write(JSON.stringify({ ok: false })); process.exitCode = 1 }
finally { if (parent !== undefined) try { fs.closeSync(parent) } catch {} }
`
const ATOMIC_ENTRY_WORKER = String.raw`
const fs = require('node:fs')
const [kind, name, parentPath, expectedParentDev, expectedParentIno, expectation, expectedDev, expectedIno, expectedSize, expectedMtime, expectedCtime, source, sourceParent, sourceName, sourceParentDev, sourceParentIno, sourceDev, sourceIno, outputMode] = process.argv.slice(1)
let parent
let temp
function fail() { process.stdout.write(JSON.stringify({ ok: false })); process.exitCode = 1 }
try {
  if (!['file','symlink','hardlink'].includes(kind) || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error('bad name')
  parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const parentStat = fs.fstatSync(parent, { bigint: true })
  if (!parentStat.isDirectory() || parentStat.dev !== BigInt(expectedParentDev) || parentStat.ino !== BigInt(expectedParentIno)) throw new Error('parent mismatch')
  process.stderr.write('CWD_BOUND\n')
  const ack = Buffer.alloc(1)
  if (fs.readSync(3, ack, 0, 1, null) !== 1 || ack[0] !== 1) throw new Error('ack missing')
  let current
  try { current = fs.lstatSync(name, { bigint: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (expectation === 'absent') { if (current) throw new Error('target appeared') }
  else {
    if (!current || current.dev !== BigInt(expectedDev) || current.ino !== BigInt(expectedIno) || current.size !== BigInt(expectedSize) || current.mtimeNs !== BigInt(expectedMtime) || current.ctimeNs !== BigInt(expectedCtime) || current.isDirectory()) throw new Error('target changed')
  }
  temp = '.' + name + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.pending'
  if (kind === 'file') {
    const payload = fs.readFileSync(0)
    if (payload.length > ${MAX_RECOVERY_FILE_BYTES}) throw new Error('payload too large')
    const file = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try {
      let offset = 0
      while (offset < payload.length) { const written = fs.writeSync(file, payload, offset, payload.length - offset); if (written < 1) throw new Error('short write'); offset += written }
      fs.fsyncSync(file)
    } finally { fs.closeSync(file); payload.fill(0) }
  } else if (kind === 'symlink') {
    const payload = fs.readFileSync(0)
    if (payload.length > 8192 || payload.includes(0)) throw new Error('bad link')
    fs.symlinkSync(payload.toString('utf8'), temp)
    payload.fill(0)
  } else {
    const sourceParentStat = fs.lstatSync(sourceParent, { bigint: true })
    if (!sourceParentStat.isDirectory() || sourceParentStat.dev !== BigInt(sourceParentDev) || sourceParentStat.ino !== BigInt(sourceParentIno)) throw new Error('source parent changed')
    const sourceStat = fs.lstatSync(source, { bigint: true })
    if (!sourceStat.isFile() || sourceStat.dev !== BigInt(sourceDev) || sourceStat.ino !== BigInt(sourceIno)) throw new Error('source changed')
    fs.linkSync(source, temp)
  }
  let beforeCommit
  const boundParent = fs.lstatSync(parentPath, { bigint: true })
  if (!boundParent.isDirectory() || boundParent.dev !== BigInt(expectedParentDev) || boundParent.ino !== BigInt(expectedParentIno)) throw new Error('parent path changed before commit')
  try { beforeCommit = fs.lstatSync(name, { bigint: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (expectation === 'absent') { if (beforeCommit) throw new Error('target appeared') }
  else if (!beforeCommit || beforeCommit.dev !== BigInt(expectedDev) || beforeCommit.ino !== BigInt(expectedIno) || beforeCommit.size !== BigInt(expectedSize) || beforeCommit.mtimeNs !== BigInt(expectedMtime) || beforeCommit.ctimeNs !== BigInt(expectedCtime) || beforeCommit.isDirectory()) throw new Error('target changed before commit')
  fs.renameSync(temp, name)
  temp = undefined
  fs.fsyncSync(parent)
  const final = fs.lstatSync(name, { bigint: true })
  if ((kind === 'symlink') !== final.isSymbolicLink() || (kind !== 'symlink' && !final.isFile()) || (kind === 'hardlink' && final.ino !== BigInt(sourceIno))) throw new Error('final type mismatch')
  if (outputMode === 'malformed') process.stdout.write('{')
  else if (outputMode !== 'suppress') process.stdout.write(JSON.stringify({ ok: true, device: final.dev.toString(), inode: final.ino.toString(), size: final.size.toString() }))
} catch { fail() }
finally { if (temp) try { fs.unlinkSync(temp) } catch {}; if (parent !== undefined) try { fs.closeSync(parent) } catch {} }
`

export interface PathIdentity {
  device: bigint
  inode: bigint
  type: 'file' | 'directory' | 'symlink'
  size: bigint
  modifiedAtNs: bigint
  changedAtNs: bigint
}

export class DirectoryEnsureError extends Error {
  constructor(
    readonly outcome: 'drift' | 'ambiguous',
    message: string,
  ) {
    super(message)
  }
}

export function identity(stat: BigIntStats): PathIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    modifiedAtNs: stat.mtimeNs,
    changedAtNs: stat.ctimeNs,
  }
}

export async function lstatIdentity(path: string): Promise<PathIdentity | null> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error('unsupported path type')
    }
    return identity(stat)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function safeRelativePath(value: string): string {
  if (
    value === '.' ||
    (!isAbsolute(value) &&
      value.length > 0 &&
      value.length <= 8192 &&
      value
        .split('/')
        .every((part) => part.length > 0 && part !== '.' && part !== '..' && !part.includes('\0')))
  ) {
    return value
  }
  throw new Error('unsafe relative path')
}

export function pathUnder(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path))
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

export function pathsOverlap(left: string, right: string): boolean {
  return pathUnder(left, right) || pathUnder(right, left)
}

export async function assertSafeDirectory(path: string): Promise<PathIdentity> {
  const stat = await lstat(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe directory')
  return identity(stat)
}

export async function assertSafeAbsoluteDirectoryChain(path: string): Promise<PathIdentity> {
  const absolute = resolve(path)
  let current = resolve('/')
  await assertSafeDirectory(current)
  for (const component of absolute.split(sep).filter(Boolean)) {
    current = join(current, component)
    await assertSafeDirectory(current)
  }
  return assertSafeDirectory(absolute)
}

export async function assertDirectoryIdentity(path: string, expected: PathIdentity): Promise<void> {
  const actual = await assertSafeDirectory(path)
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error('directory identity changed')
  }
}

export async function assertSafeParentChain(root: string, target: string): Promise<void> {
  if (!pathUnder(root, target)) throw new Error('path leaves root')
  let current = resolve(root)
  await assertSafeDirectory(current)
  const parentRelative = relative(current, dirname(resolve(target)))
  for (const component of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, component)
    await assertSafeDirectory(current)
  }
}

export async function mkdirUnderRoot(root: string, relativePath: string): Promise<string> {
  const safe = safeRelativePath(relativePath)
  const destination = safe === '.' ? resolve(root) : resolve(root, safe)
  if (!pathUnder(root, destination)) throw new Error('directory leaves root')
  if (safe === '.') return destination
  let current = resolve(root)
  for (const component of safe.split('/')) {
    current = join(current, component)
    const parentPath = dirname(current)
    const parent = await assertSafeDirectory(parentPath)
    const result = await execFileJson(
      DIRECTORY_BOUND_MKDIR_WORKER,
      [basename(current), parent.device.toString(), parent.inode.toString()],
      parentPath,
    )
    if (
      result.ok !== true ||
      typeof result.device !== 'string' ||
      typeof result.inode !== 'string'
    ) {
      throw new Error('directory create failed')
    }
    await assertDirectoryIdentity(parentPath, parent)
    const created = await assertSafeDirectory(current)
    if (created.device.toString() !== result.device || created.inode.toString() !== result.inode) {
      throw new Error('directory create acknowledgement is ambiguous')
    }
  }
  return destination
}

export async function atomicEnsureDirectory(
  destination: string,
  expected: PathIdentity | null,
  expectedParent?: PathIdentity,
  acknowledgementMode: 'normal' | 'suppress' | 'malformed' | 'crash-after-mutation' = 'normal',
): Promise<PathIdentity> {
  if (expected && expected.type !== 'directory') throw new Error('directory expectation invalid')
  const absolute = resolve(destination)
  const parentPath = dirname(absolute)
  const parent = await assertSafeDirectory(parentPath)
  if (
    expectedParent &&
    (parent.device !== expectedParent.device || parent.inode !== expectedParent.inode)
  )
    throw new Error('directory parent changed')
  const worker = spawn(
    process.execPath,
    [
      '-e',
      DIRECTORY_BOUND_ENSURE_WORKER,
      basename(absolute),
      parentPath,
      parent.device.toString(),
      parent.inode.toString(),
      expected ? 'present' : 'absent',
      expected?.device.toString() ?? '0',
      expected?.inode.toString() ?? '0',
      acknowledgementMode,
    ],
    {
      cwd: parentPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    },
  )
  let stdout = ''
  const exit = await new Promise<number | null>((resolveExit, reject) => {
    worker.once('error', reject)
    worker.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_WORKER_OUTPUT) worker.kill()
    })
    worker.once('close', resolveExit)
  })
  await assertDirectoryIdentity(parentPath, parent)
  const final = await lstatIdentity(absolute)
  let result: { ok?: unknown; device?: unknown; inode?: unknown; phase?: unknown } = {}
  let acknowledgementParsed = false
  try {
    result = JSON.parse(stdout) as typeof result
    acknowledgementParsed = true
  } catch {
    // Exit status plus the durable bound final identity reconciles a lost acknowledgement.
  }
  if (exit !== 0) {
    if (acknowledgementParsed && result.ok === false && result.phase === 'precondition')
      throw new DirectoryEnsureError('drift', 'directory precondition changed before mutation')
    throw new DirectoryEnsureError(
      'ambiguous',
      'directory ensure outcome is ambiguous; inspect the destination and resume safely',
    )
  }
  if (final?.type !== 'directory') throw new Error('directory ensure failed')
  if (
    (acknowledgementParsed && result.ok !== true) ||
    (result.ok === true &&
      (final.device.toString() !== result.device || final.inode.toString() !== result.inode)) ||
    (expected && (final.device !== expected.device || final.inode !== expected.inode))
  )
    throw new Error('directory ensure acknowledgement is ambiguous')
  return final
}

export interface AtomicPublishOptions {
  kind: 'file' | 'symlink' | 'hardlink'
  destination: string
  expected: PathIdentity | null
  expectedParent?: PathIdentity
  payload?: Uint8Array | string
  hardlinkSource?: { path: string; identity: PathIdentity }
  beforeCommit?: () => void | Promise<void>
  acknowledgementMode?: 'normal' | 'suppress' | 'malformed'
}

export async function atomicPublish(options: AtomicPublishOptions): Promise<PathIdentity> {
  const parentPath = dirname(resolve(options.destination))
  const parent = await assertSafeDirectory(parentPath)
  if (
    options.expectedParent &&
    (parent.device !== options.expectedParent.device ||
      parent.inode !== options.expectedParent.inode)
  )
    throw new Error('atomic parent changed')
  if (options.expected?.type === 'directory')
    throw new Error('directory replacement is unsupported')
  const source = options.hardlinkSource
  const sourceParent = source ? await assertSafeDirectory(dirname(source.path)) : undefined
  const child = spawn(
    process.execPath,
    [
      '-e',
      ATOMIC_ENTRY_WORKER,
      options.kind,
      basename(options.destination),
      parentPath,
      parent.device.toString(),
      parent.inode.toString(),
      options.expected ? 'present' : 'absent',
      options.expected?.device.toString() ?? '0',
      options.expected?.inode.toString() ?? '0',
      options.expected?.size.toString() ?? '0',
      options.expected?.modifiedAtNs.toString() ?? '0',
      options.expected?.changedAtNs.toString() ?? '0',
      source?.path ?? '',
      source ? dirname(source.path) : '',
      source ? basename(source.path) : '',
      sourceParent?.device.toString() ?? '0',
      sourceParent?.inode.toString() ?? '0',
      source?.identity.device.toString() ?? '0',
      source?.identity.inode.toString() ?? '0',
      options.acknowledgementMode ?? 'normal',
    ],
    {
      cwd: parentPath,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let stdout = Buffer.alloc(0)
  let stderr = ''
  const done = new Promise<number | null>((resolveDone, reject) => {
    child.once('error', reject)
    child.once('close', resolveDone)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.length > MAX_WORKER_OUTPUT) child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > MAX_WORKER_OUTPUT) child.kill()
    })
  })
  try {
    for (let attempt = 0; !stderr.includes('CWD_BOUND') && attempt < 200; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      if (child.exitCode !== null) break
    }
    if (!stderr.includes('CWD_BOUND')) throw new Error('atomic writer did not bind destination')
    await options.beforeCommit?.()
    ;(child.stdio[3] as NodeJS.WritableStream).write(Buffer.from([1]))
    ;(child.stdio[3] as NodeJS.WritableStream).end()
    if (options.kind !== 'hardlink') child.stdin.end(options.payload ?? '')
    else child.stdin.end()
    const exit = await done
    let result: { ok?: unknown; device?: unknown; inode?: unknown; size?: unknown } = {}
    try {
      result = JSON.parse(stdout.toString('utf8')) as typeof result
    } catch {
      // A lost acknowledgement is reconciled against the durable final object below.
    }
    await assertDirectoryIdentity(parentPath, parent)
    const final = await lstatIdentity(options.destination)
    if (!final || exit !== 0) throw new Error('atomic writer failed')
    if (
      result.ok === true &&
      (final.device.toString() !== result.device || final.inode.toString() !== result.inode)
    )
      throw new Error('atomic writer final identity is ambiguous')
    if (options.kind === 'file') {
      const expectedPayload = Buffer.from(options.payload ?? '')
      const actual = await readDirectoryBoundFile(
        parentPath,
        basename(options.destination),
        MAX_RECOVERY_FILE_BYTES,
      )
      try {
        if (!actual.equals(expectedPayload)) throw new Error('atomic file reconciliation failed')
      } finally {
        actual.fill(0)
        expectedPayload.fill(0)
      }
    } else if (options.kind === 'symlink') {
      if ((await readLinkSafely(options.destination)) !== String(options.payload ?? ''))
        throw new Error('atomic link reconciliation failed')
    } else if (
      !source ||
      final.inode !== source.identity.inode ||
      final.device !== source.identity.device
    ) {
      throw new Error('atomic hardlink reconciliation failed')
    }
    return final
  } catch (error) {
    child.kill()
    await done.catch(() => undefined)
    throw error
  }
}

export async function readVerifiedFile(
  path: string,
  expectedBytes: number,
  expectedHash: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_RECOVERY_FILE_BYTES) {
    throw new Error('file exceeds recovery limit')
  }
  const content = await readDirectoryBoundFile(
    dirname(path),
    basename(path),
    MAX_RECOVERY_FILE_BYTES,
  )
  if (
    content.length !== expectedBytes ||
    createHash('sha256').update(content).digest('hex') !== expectedHash
  ) {
    content.fill(0)
    throw new Error('file content does not match')
  }
  return content
}

export async function fingerprintFile(
  path: string,
  maximum = MAX_RECOVERY_FILE_BYTES,
): Promise<{
  hash: string
  bytes: number
}> {
  const content = await readDirectoryBoundFile(dirname(path), basename(path), maximum)
  try {
    return { hash: createHash('sha256').update(content).digest('hex'), bytes: content.length }
  } finally {
    content.fill(0)
  }
}

export async function atomicRenameDirectory(
  pending: string,
  final: string,
  expectedRoot: PathIdentity,
  acknowledgementMode: 'normal' | 'suppress' | 'malformed' = 'normal',
): Promise<void> {
  const root = dirname(final)
  await assertDirectoryIdentity(root, expectedRoot)
  const pendingIdentity = await assertSafeDirectory(pending)
  const result = await execFileJson(
    DIRECTORY_BOUND_RENAME_WORKER,
    [
      basename(pending),
      basename(final),
      expectedRoot.device.toString(),
      expectedRoot.inode.toString(),
      pendingIdentity.device.toString(),
      pendingIdentity.inode.toString(),
      acknowledgementMode,
    ],
    root,
    true,
  )
  await assertDirectoryIdentity(root, expectedRoot)
  const published = await assertSafeDirectory(final)
  if (published.device !== pendingIdentity.device || published.inode !== pendingIdentity.inode) {
    throw new Error('directory publish acknowledgement is ambiguous')
  }
  if (result.ok !== true && acknowledgementMode === 'normal')
    throw new Error('directory publish failed')
}

export async function readLinkSafely(path: string): Promise<string> {
  const before = await lstatIdentity(path)
  if (before?.type !== 'symlink') throw new Error('not a symbolic link')
  const target = await readlink(path)
  const after = await lstatIdentity(path)
  if (!after || after.device !== before.device || after.inode !== before.inode) {
    throw new Error('symbolic link changed')
  }
  return target
}

async function execFileJson(
  worker: string,
  args: string[],
  cwd: string,
  tolerateMalformed = false,
): Promise<Record<string, unknown>> {
  try {
    const result = await execFileAsync(process.execPath, ['-e', worker, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: MAX_WORKER_OUTPUT,
      windowsHide: true,
    })
    return JSON.parse(result.stdout) as Record<string, unknown>
  } catch (error) {
    if (tolerateMalformed) return {}
    throw error
  }
}

export async function readDirectoryBoundFile(
  parentPath: string,
  name: string,
  maximum: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || name !== basename(name)) {
    throw new Error('invalid bounded read')
  }
  const parent = await assertSafeDirectory(parentPath)
  const child = spawn(
    process.execPath,
    [
      '-e',
      DIRECTORY_BOUND_READ_WORKER,
      name,
      parent.device.toString(),
      parent.inode.toString(),
      maximum.toString(),
    ],
    { cwd: parentPath, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  )
  let content = Buffer.alloc(0)
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.stdout.on('data', (chunk: Buffer) => {
      content = Buffer.concat([content, chunk])
      if (content.length > maximum) child.kill()
    })
    child.once('close', resolve)
  })
  if (exit !== 0 || content.length > maximum) {
    content.fill(0)
    throw new Error('bounded directory read failed')
  }
  await assertDirectoryIdentity(parentPath, parent)
  return content
}

export async function deleteEntrySafely(
  path: string,
  expected: PathIdentity,
  expectedParent?: PathIdentity,
): Promise<void> {
  const parentPath = dirname(resolve(path))
  const parent = await assertSafeDirectory(parentPath)
  if (
    expectedParent &&
    (parent.device !== expectedParent.device || parent.inode !== expectedParent.inode)
  )
    throw new Error('deletion parent changed')
  const result = await execFileJson(
    DIRECTORY_BOUND_DELETE_WORKER,
    [
      basename(path),
      parentPath,
      parent.device.toString(),
      parent.inode.toString(),
      expected.device.toString(),
      expected.inode.toString(),
      expected.type,
    ],
    parentPath,
  )
  if (result.ok !== true) throw new Error('directory-bound deletion failed')
  await assertDirectoryIdentity(parentPath, parent)
  if (await lstatIdentity(path)) throw new Error('deletion acknowledgement is ambiguous')
}

import { execFile, spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { promisify } from 'node:util'
import type { ManifestEntryV1 } from '../verify/index.js'
import { assertDirectoryIdentity, assertSafeDirectory, lstatIdentity } from './safe-io.js'
import type { PathIdentity } from './safe-io.js'
import type { MetadataCommandRunner, MetadataIssue, MetadataOptions } from './types.js'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 2 * 1024 * 1024
const MAX_XATTR_ARG_BYTES = 32 * 1024
const TIMEOUT_MS = 5000
const NS_TOLERANCE = 1_000_000n
const PORTABLE_METADATA_WORKER = String.raw`
const fs = require('node:fs')
const [name, parentDev, parentIno, targetDev, targetIno, kind, mode, modifiedAtNs] = process.argv.slice(1)
let parent
let targetFd
try {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error('bad name')
  parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const held = fs.fstatSync(parent, { bigint: true })
  if (held.dev !== BigInt(parentDev) || held.ino !== BigInt(parentIno)) throw new Error('parent mismatch')
  let target = fs.lstatSync(name, { bigint: true })
  if (target.dev !== BigInt(targetDev) || target.ino !== BigInt(targetIno)) throw new Error('target mismatch')
  const seconds = Number(BigInt(modifiedAtNs)) / 1000000000
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('bad timestamp')
  if (kind === 'symlink') throw new Error('symlink metadata is not fd-bound')
  else {
    targetFd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (kind === 'directory' ? fs.constants.O_DIRECTORY : 0))
    const opened = fs.fstatSync(targetFd, { bigint: true })
    if (opened.dev !== target.dev || opened.ino !== target.ino) throw new Error('opened target mismatch')
    fs.fchmodSync(targetFd, Number(mode))
    fs.futimesSync(targetFd, seconds, seconds)
  }
  fs.fsyncSync(parent)
  target = fs.lstatSync(name, { bigint: true })
  if (target.dev !== BigInt(targetDev) || target.ino !== BigInt(targetIno)) throw new Error('target changed')
  process.stdout.write(JSON.stringify({ ok: true }))
} catch { process.stdout.write(JSON.stringify({ ok: false })); process.exitCode = 1 }
finally { if (targetFd !== undefined) try { fs.closeSync(targetFd) } catch {}; if (parent !== undefined) try { fs.closeSync(parent) } catch {} }
`
const NATIVE_METADATA_WORKER = String.raw`
const childProcess = require('node:child_process')
const fs = require('node:fs')
const [executable, encodedArgs, name, parentDev, parentIno, targetDev, targetIno] = process.argv.slice(1)
let parent
try {
  const allowed = new Set(['/usr/bin/xattr','/usr/bin/stat'])
  if (!allowed.has(executable) || !name || name.includes('/') || name.includes('\0')) throw new Error('bad command')
  parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const held = fs.fstatSync(parent, { bigint: true })
  if (held.dev !== BigInt(parentDev) || held.ino !== BigInt(parentIno)) throw new Error('parent mismatch')
  let target = fs.lstatSync(name, { bigint: true })
  if (target.dev !== BigInt(targetDev) || target.ino !== BigInt(targetIno)) throw new Error('target mismatch')
  const args = JSON.parse(Buffer.from(encodedArgs, 'base64').toString('utf8'))
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('bad args')
  const output = childProcess.execFileSync(executable, args, { encoding: 'buffer', timeout: ${TIMEOUT_MS}, maxBuffer: ${MAX_OUTPUT}, windowsHide: true })
  target = fs.lstatSync(name, { bigint: true })
  if (target.dev !== BigInt(targetDev) || target.ino !== BigInt(targetIno)) throw new Error('target changed')
  process.stdout.write(output)
} catch { process.exitCode = 1 }
finally { if (parent !== undefined) try { fs.closeSync(parent) } catch {} }
`
const NATIVE_MUTATION_WORKER = String.raw`
const childProcess = require('node:child_process')
const fs = require('node:fs')
const [executable, encodedArgs, name, kind, parentDev, parentIno, targetDev, targetIno] = process.argv.slice(1)
let parent
let targetFd
try {
  if (!['/usr/bin/xattr','/usr/bin/chflags'].includes(executable) || !['file','directory'].includes(kind) || !name || name.includes('/') || name.includes('\0')) throw new Error('bad mutation')
  parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const held = fs.fstatSync(parent, { bigint: true })
  if (held.dev !== BigInt(parentDev) || held.ino !== BigInt(parentIno)) throw new Error('parent mismatch')
  const target = fs.lstatSync(name, { bigint: true })
  if (target.dev !== BigInt(targetDev) || target.ino !== BigInt(targetIno) || (kind === 'file' ? !target.isFile() : !target.isDirectory())) throw new Error('target mismatch')
  targetFd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (kind === 'directory' ? fs.constants.O_DIRECTORY : 0))
  const opened = fs.fstatSync(targetFd, { bigint: true })
  if (opened.dev !== target.dev || opened.ino !== target.ino) throw new Error('opened target mismatch')
  process.stderr.write('FD_BOUND\n')
  const ack = Buffer.alloc(1)
  if (fs.readSync(4, ack, 0, 1, null) !== 1 || ack[0] !== 1) throw new Error('ack missing')
  const args = JSON.parse(Buffer.from(encodedArgs, 'base64').toString('utf8'))
  if (!Array.isArray(args) || args.filter((arg) => arg === '__RESTORE_FD__').length !== 1 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('bad args')
  if (executable === '/usr/bin/xattr' && (args.length !== 6 || args[0] !== '-w' || args[1] !== '-x' || args[2] !== '--' || !/^[0-9a-f]*$/i.test(args[4]))) throw new Error('bad xattr mutation')
  if (executable === '/usr/bin/chflags' && (args.length !== 2 || !/^(0|[a-zA-Z0-9_-]+(?:,[a-zA-Z0-9_-]+)*)$/.test(args[0]))) throw new Error('bad flags mutation')
  const boundArgs = args.map((arg) => arg === '__RESTORE_FD__' ? '/dev/fd/3' : arg)
  childProcess.execFileSync(executable, boundArgs, { encoding: 'buffer', timeout: ${TIMEOUT_MS}, maxBuffer: ${MAX_OUTPUT}, windowsHide: true, stdio: ['ignore','pipe','pipe',targetFd] })
  const afterFd = fs.fstatSync(targetFd, { bigint: true })
  if (afterFd.dev !== target.dev || afterFd.ino !== target.ino) throw new Error('held target changed')
  const afterPath = fs.lstatSync(name, { bigint: true })
  if (afterPath.dev !== target.dev || afterPath.ino !== target.ino) throw new Error('target path changed')
  process.stdout.write(JSON.stringify({ ok: true }))
} catch { process.stdout.write(JSON.stringify({ ok: false })); process.exitCode = 1 }
finally { if (targetFd !== undefined) try { fs.closeSync(targetFd) } catch {}; if (parent !== undefined) try { fs.closeSync(parent) } catch {} }
`

const issue = (code: string, message: string): MetadataIssue => ({ code, message })

function closeEnough(actual: bigint, expected: string, tolerance = NS_TOLERANCE): boolean {
  const difference = actual - BigInt(expected)
  return (difference < 0n ? -difference : difference) <= tolerance
}

function sameObject(
  actual: PathIdentity | null,
  expected: PathIdentity,
  type: ManifestEntryV1['type'],
): boolean {
  return Boolean(
    actual &&
      actual.type === type &&
      actual.device === expected.device &&
      actual.inode === expected.inode,
  )
}

async function assertMetadataObject(
  path: string,
  expected: PathIdentity,
  type: ManifestEntryV1['type'],
): Promise<void> {
  if (!sameObject(await lstatIdentity(path), expected, type))
    throw new Error('metadata target changed')
}

async function boundPortableMetadata(
  path: string,
  entry: ManifestEntryV1,
  operationTarget: PathIdentity,
): Promise<void> {
  const parentPath = dirname(path)
  const parent = await assertSafeDirectory(parentPath)
  const target = await lstatIdentity(path)
  if (!sameObject(target, operationTarget, entry.type)) throw new Error('missing metadata target')
  const result = await execFileAsync(
    process.execPath,
    [
      '-e',
      PORTABLE_METADATA_WORKER,
      basename(path),
      parent.device.toString(),
      parent.inode.toString(),
      operationTarget.device.toString(),
      operationTarget.inode.toString(),
      entry.type,
      entry.metadata.mode.toString(),
      entry.metadata.modifiedAtNs,
    ],
    { cwd: parentPath, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 4096, windowsHide: true },
  )
  if ((JSON.parse(result.stdout) as { ok?: unknown }).ok !== true)
    throw new Error('metadata failed')
  await assertDirectoryIdentity(parentPath, parent)
  const after = await lstatIdentity(path)
  if (!sameObject(after, operationTarget, entry.type)) {
    throw new Error('metadata target changed')
  }
}

async function injectedCommand(
  path: string,
  executable: string,
  args: string[],
  options: MetadataOptions,
): Promise<Buffer> {
  const parentPath = dirname(path)
  const parent = await assertSafeDirectory(parentPath)
  const target = await lstatIdentity(path)
  if (!target) throw new Error('missing metadata target')
  await options.onBeforeCommand?.(path)
  try {
    await assertDirectoryIdentity(parentPath, parent)
    const rebound = await lstatIdentity(path)
    if (!rebound || rebound.device !== target.device || rebound.inode !== target.inode) {
      throw new Error('metadata target changed')
    }
    const output = await (options.commandRunner as MetadataCommandRunner)(
      executable,
      args.map((argument) => (argument === path ? basename(path) : argument)),
    )
    if (output.stdout.length > MAX_OUTPUT || (output.stderr?.length ?? 0) > MAX_OUTPUT) {
      throw new Error('metadata output too large')
    }
    await assertDirectoryIdentity(parentPath, parent)
    const after = await lstatIdentity(path)
    if (!after || after.device !== target.device || after.inode !== target.inode) {
      throw new Error('metadata target changed')
    }
    return output.stdout
  } finally {
    await options.onAfterCommand?.(path)
  }
}

async function boundNativeCommand(
  path: string,
  executable: string,
  args: string[],
  options: MetadataOptions,
): Promise<Buffer> {
  if (options.commandRunner) return injectedCommand(path, executable, args, options)
  const parentPath = dirname(path)
  const parent = await assertSafeDirectory(parentPath)
  const target = await lstatIdentity(path)
  if (!target) throw new Error('missing metadata target')
  const relativeArgs = args.map((argument) => (argument === path ? basename(path) : argument))
  const encoded = Buffer.from(JSON.stringify(relativeArgs)).toString('base64')
  if (encoded.length > 128 * 1024) throw new Error('metadata arguments too large')
  await options.onBeforeCommand?.(path)
  const child = spawn(
    process.execPath,
    [
      '-e',
      NATIVE_METADATA_WORKER,
      executable,
      encoded,
      basename(path),
      parent.device.toString(),
      parent.inode.toString(),
      target.device.toString(),
      target.inode.toString(),
    ],
    { cwd: parentPath, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  )
  let output = Buffer.alloc(0)
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.stdout.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk])
      if (output.length > MAX_OUTPUT) child.kill()
    })
    child.once('close', resolve)
  }).finally(() => options.onAfterCommand?.(path))
  if (exit !== 0 || output.length > MAX_OUTPUT) throw new Error('metadata command failed')
  await assertDirectoryIdentity(parentPath, parent)
  const after = await lstatIdentity(path)
  if (!after || after.device !== target.device || after.inode !== target.inode) {
    throw new Error('metadata target changed')
  }
  return output
}

async function boundNativeMutation(
  path: string,
  entry: ManifestEntryV1,
  executable: '/usr/bin/xattr' | '/usr/bin/chflags',
  args: string[],
  options: MetadataOptions,
  operationTarget: PathIdentity,
): Promise<void> {
  if (entry.type === 'symlink' || options.commandRunner)
    throw new Error('native mutation is not object-bound')
  const parentPath = dirname(path)
  const parent = await assertSafeDirectory(parentPath)
  const target = await lstatIdentity(path)
  if (!sameObject(target, operationTarget, entry.type)) throw new Error('missing metadata target')
  const encoded = Buffer.from(JSON.stringify(args)).toString('base64')
  if (encoded.length > 128 * 1024) throw new Error('metadata arguments too large')
  await options.onBeforeCommand?.(path)
  const child = spawn(
    process.execPath,
    [
      '-e',
      NATIVE_MUTATION_WORKER,
      executable,
      encoded,
      basename(path),
      entry.type,
      parent.device.toString(),
      parent.inode.toString(),
      operationTarget.device.toString(),
      operationTarget.inode.toString(),
    ],
    { cwd: parentPath, stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'], windowsHide: true },
  )
  if (!child.stdout || !child.stderr) throw new Error('metadata worker pipes unavailable')
  const childStdout = child.stdout
  const childStderr = child.stderr
  let stdout = Buffer.alloc(0)
  let stderr = ''
  const done = new Promise<number | null>((resolveDone, reject) => {
    child.once('error', reject)
    child.once('close', resolveDone)
    childStdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.length > 4096) child.kill()
    })
    childStderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 4096) child.kill()
    })
  })
  try {
    for (let attempt = 0; !stderr.includes('FD_BOUND') && attempt < 200; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      if (child.exitCode !== null) break
    }
    if (!stderr.includes('FD_BOUND')) throw new Error('metadata worker did not bind target')
    await options.onNativeFdBound?.(path)
    ;(child.stdio[4] as NodeJS.WritableStream).end(Buffer.from([1]))
    const exit = await done
    if (exit !== 0 || (JSON.parse(stdout.toString('utf8')) as { ok?: unknown }).ok !== true)
      throw new Error('metadata mutation failed')
  } catch (error) {
    child.kill()
    await done.catch(() => undefined)
    throw error
  } finally {
    await options.onAfterCommand?.(path)
  }
  await assertDirectoryIdentity(parentPath, parent)
  const after = await lstatIdentity(path)
  if (!sameObject(after, operationTarget, entry.type)) throw new Error('metadata target changed')
}

export async function restoreMetadata(
  path: string,
  entry: ManifestEntryV1,
  options: MetadataOptions = {},
): Promise<MetadataIssue[]> {
  const issues: MetadataIssue[] = []
  const operationTarget = await lstatIdentity(path)
  if (!operationTarget || operationTarget.type !== entry.type)
    return [issue('METADATA_TARGET_CHANGED', 'Metadata target identity is not the planned object')]
  let mutationSafe = true
  if (entry.type === 'symlink') {
    mutationSafe = false
    issues.push(
      issue(
        'SYMLINK_METADATA_MUTATION_UNSAFE',
        'Symbolic-link metadata cannot be restored with an object-bound mutation',
      ),
    )
  } else {
    try {
      await assertMetadataObject(path, operationTarget, entry.type)
      await boundPortableMetadata(path, entry, operationTarget)
      await assertMetadataObject(path, operationTarget, entry.type)
    } catch {
      mutationSafe = false
      issues.push(
        issue('PORTABLE_METADATA_RESTORE_FAILED', 'Mode or timestamp could not be restored safely'),
      )
    }
  }

  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    if ((entry.metadata.xattrs?.length ?? 0) > 0)
      issues.push(issue('XATTR_UNSUPPORTED', 'Extended attributes require macOS'))
    if ((entry.metadata.flags?.length ?? 0) > 0)
      issues.push(issue('FLAGS_UNSUPPORTED', 'Filesystem flags require macOS'))
    if (entry.metadata.createdAtNs)
      issues.push(issue('CREATED_AT_UNSUPPORTED', 'Creation timestamp requires macOS'))
    return issues
  }
  const attributes = entry.metadata.xattrs ?? []
  for (let index = 0; index < attributes.length; index++) {
    const attribute = attributes[index]
    if (!mutationSafe) {
      issues.push(
        issue('XATTR_RESTORE_SKIPPED', 'Later extended attributes were skipped after target drift'),
      )
      break
    }
    const value = Buffer.from(attribute.value, 'base64')
    if (value.length > MAX_XATTR_ARG_BYTES) {
      issues.push(issue('XATTR_TOO_LARGE', 'An extended attribute exceeds the safe restore limit'))
      continue
    }
    try {
      await assertMetadataObject(path, operationTarget, entry.type)
      await boundNativeMutation(
        path,
        entry,
        '/usr/bin/xattr',
        ['-w', '-x', '--', attribute.name, value.toString('hex'), '__RESTORE_FD__'],
        options,
        operationTarget,
      )
      await assertMetadataObject(path, operationTarget, entry.type)
    } catch {
      mutationSafe = false
      issues.push(issue('XATTR_RESTORE_FAILED', 'An extended attribute could not be restored'))
    } finally {
      value.fill(0)
    }
  }
  if (entry.metadata.createdAtNs) {
    issues.push(
      issue(
        'CREATED_AT_MUTATION_UNSAFE',
        'Creation timestamp has no proven object-bound restore operation',
      ),
    )
  }
  // Immutable flags are deliberately last so later metadata operations cannot silently fail.
  if (!mutationSafe)
    issues.push(
      issue('FLAGS_RESTORE_SKIPPED', 'Filesystem flags were not attempted after target drift'),
    )
  else
    try {
      await assertMetadataObject(path, operationTarget, entry.type)
      await boundNativeMutation(
        path,
        entry,
        '/usr/bin/chflags',
        [(entry.metadata.flags ?? []).join(',') || '0', '__RESTORE_FD__'],
        options,
        operationTarget,
      )
      await assertMetadataObject(path, operationTarget, entry.type)
    } catch {
      issues.push(issue('FLAGS_RESTORE_FAILED', 'Filesystem flags could not be restored'))
    }
  return issues
}

export async function verifyMetadata(
  path: string,
  entry: ManifestEntryV1,
  options: MetadataOptions = {},
): Promise<MetadataIssue[]> {
  const issues: MetadataIssue[] = []
  const stat = await lstat(path, { bigint: true }).catch(() => undefined)
  if (!stat) return [issue('METADATA_TARGET_MISSING', 'Restored entry could not be inspected')]
  if (Number(stat.mode & 0o7777n) !== entry.metadata.mode)
    issues.push(issue('MODE_VERIFY_FAILED', 'Restored mode does not match'))
  if (!closeEnough(stat.mtimeNs, entry.metadata.modifiedAtNs))
    issues.push(issue('TIMESTAMP_VERIFY_FAILED', 'Restored timestamp does not match'))
  if (
    entry.metadata.createdAtNs &&
    !closeEnough(stat.birthtimeNs, entry.metadata.createdAtNs, 1_000_000_000n)
  ) {
    issues.push(issue('CREATED_AT_VERIFY_FAILED', 'Restored creation time does not match'))
  }
  if ((options.platform ?? process.platform) !== 'darwin') return issues
  for (const attribute of entry.metadata.xattrs ?? []) {
    try {
      const actual = (
        await boundNativeCommand(
          path,
          '/usr/bin/xattr',
          ['-p', '-x', '-s', attribute.name, '--', path],
          options,
        )
      )
        .toString('ascii')
        .replace(/\s/g, '')
        .toLowerCase()
      if (actual !== Buffer.from(attribute.value, 'base64').toString('hex'))
        throw new Error('mismatch')
    } catch {
      issues.push(issue('XATTR_VERIFY_FAILED', 'An extended attribute could not be verified'))
    }
  }
  try {
    const actual = (
      await boundNativeCommand(path, '/usr/bin/stat', ['-f', '%Sf', '--', path], options)
    )
      .toString('utf8')
      .trim()
      .split(',')
      .map((flag) => flag.trim())
      .filter((flag) => flag && flag !== '-')
      .sort()
    const expected = [...(entry.metadata.flags ?? [])].sort()
    if (actual.length !== expected.length || actual.some((flag, index) => flag !== expected[index]))
      throw new Error('mismatch')
  } catch {
    issues.push(issue('FLAGS_VERIFY_FAILED', 'Filesystem flags could not be verified'))
  }
  return issues
}

export async function captureCurrentMetadata(
  path: string,
  _type: ManifestEntryV1['type'],
  options: MetadataOptions = {},
): Promise<ManifestEntryV1['metadata']> {
  const beforeIdentity = await lstatIdentity(path)
  const before = await lstat(path, { bigint: true })
  if (!beforeIdentity) throw new Error('metadata source missing')
  const metadata: ManifestEntryV1['metadata'] = {
    mode: Number(before.mode & 0o7777n),
    size: Number(before.size),
    modifiedAtNs: before.mtimeNs.toString(),
    ...(before.birthtimeNs > 0n ? { createdAtNs: before.birthtimeNs.toString() } : {}),
  }
  if ((options.platform ?? process.platform) === 'darwin') {
    const names = (await boundNativeCommand(path, '/usr/bin/xattr', ['-s', '--', path], options))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .sort()
    const xattrs: Array<{ name: string; value: string }> = []
    let total = 0
    for (const name of names) {
      const value = (
        await boundNativeCommand(
          path,
          '/usr/bin/xattr',
          ['-p', '-x', '-s', name, '--', path],
          options,
        )
      )
        .toString('ascii')
        .replace(/\s/g, '')
      const decoded = Buffer.from(value, 'hex')
      total += decoded.length
      if (total > MAX_OUTPUT) throw new Error('metadata too large')
      xattrs.push({ name, value: decoded.toString('base64') })
      decoded.fill(0)
    }
    if (xattrs.length > 0) metadata.xattrs = xattrs
    const flags = (
      await boundNativeCommand(path, '/usr/bin/stat', ['-f', '%Sf', '--', path], options)
    )
      .toString('utf8')
      .trim()
      .split(',')
      .map((flag) => flag.trim())
      .filter((flag) => flag && flag !== '-')
      .sort()
    if (flags.length > 0) metadata.flags = flags
  }
  const afterIdentity = await lstatIdentity(path)
  if (
    !afterIdentity ||
    afterIdentity.device !== beforeIdentity.device ||
    afterIdentity.inode !== beforeIdentity.inode
  ) {
    throw new Error('metadata source changed')
  }
  return metadata
}

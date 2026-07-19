import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { CurrentMachineInventory } from './types.js'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_BYTES = 1024 * 1024
const READ_TIMEOUT_MS = 10_000
export const HOMEBREW_EXECUTABLE = '/opt/homebrew/bin/brew'
export const VSCODE_EXECUTABLE_CANDIDATES = [
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
] as const
const BREW_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9@+._/-]{0,199}$/
const VSCODE_EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const DEFAULT_SCAN_LIMITS = {
  maxEntries: 20_000,
  maxItems: 5_000,
  maxDepth: 8,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  timeoutMs: 15_000,
} as const
const DEFAULT_MAC_ROOTS = [join(homedir(), 'Applications'), '/Applications']
const DEFAULT_RAYCAST_ROOT = join(
  homedir(),
  'Library/Application Support/com.raycast.macos/extensions',
)
const DIRECTORY_WORKER = String.raw`
const fs = require('node:fs')
const childProcess = require('node:child_process')
const [expectedDev, expectedIno, action, maxEntriesValue, maxFileBytesValue, testMutateFile] = process.argv.slice(1)
const maxEntries = Number(maxEntriesValue)
const maxFileBytes = Number(maxFileBytesValue)
let directoryFd
const identity = (stat) => ({
  device: stat.dev.toString(),
  inode: stat.ino.toString(),
  type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other',
  size: stat.size.toString(),
  modifiedAtNs: stat.mtimeNs.toString(),
  changedAtNs: stat.ctimeNs.toString(),
})
const same = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
const fixedFile = (name, convertPlist) => {
  let fileFd
  let source
  let converted
  try {
    let before
    try { before = fs.lstatSync(name, { bigint: true }) }
    catch (error) {
      if (error && error.code === 'ENOENT') return { status: 'missing' }
      return { status: 'unsafe' }
    }
    if (!before.isFile() || before.isSymbolicLink()) return { status: 'unsafe' }
    if (before.size > BigInt(maxFileBytes)) return { status: 'too-large' }
    fileFd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const heldBefore = fs.fstatSync(fileFd, { bigint: true })
    if (!same(before, heldBefore)) return { status: 'unsafe' }
    source = fs.readFileSync(fileFd)
    if (source.length > maxFileBytes) return { status: 'too-large' }
    const heldAfter = fs.fstatSync(fileFd, { bigint: true })
    const namedAfter = fs.lstatSync(name, { bigint: true })
    if (!same(before, heldAfter) || !same(before, namedAfter)) return { status: 'unsafe' }
    let payload = source
    if (convertPlist) {
      converted = testMutateFile === '1' && process.env.NODE_ENV === 'test'
        ? {
            status: 0,
            stdout: Buffer.from(JSON.stringify({
              CFBundleName: 'AuthenticatedName',
              CFBundleIdentifier: 'example.authenticated',
            })),
          }
        : childProcess.spawnSync(
            '/usr/bin/plutil',
            ['-convert', 'json', '-o', '-', '--', '/dev/fd/3'],
            { stdio: ['ignore', 'pipe', 'ignore', fileFd], timeout: 5000, maxBuffer: maxFileBytes },
          )
      if (converted.status !== 0 || converted.error || !Buffer.isBuffer(converted.stdout) || converted.stdout.length > maxFileBytes)
        return { status: 'invalid' }
      payload = converted.stdout
    }
    if (testMutateFile === '1' && process.env.NODE_ENV === 'test') fs.appendFileSync(name, ' ')
    const finalHeld = fs.fstatSync(fileFd, { bigint: true })
    const finalNamed = fs.lstatSync(name, { bigint: true })
    if (!same(before, finalHeld) || !same(before, finalNamed)) return { status: 'unsafe' }
    return { status: 'ok', sourceSize: source.length, payload: payload.toString('base64') }
  } catch { return { status: 'unsafe' } }
  finally {
    if (source) source.fill(0)
    if (converted && Buffer.isBuffer(converted.stdout)) converted.stdout.fill(0)
    if (fileFd !== undefined) try { fs.closeSync(fileFd) } catch {}
  }
}
try {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1)
    throw new Error('limits')
  directoryFd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const before = fs.fstatSync(directoryFd, { bigint: true })
  const namedBefore = fs.lstatSync('.', { bigint: true })
  if (!before.isDirectory() || before.dev.toString() !== expectedDev || before.ino.toString() !== expectedIno || !same(before, namedBefore))
    throw new Error('directory')
  let result
  if (action === 'list') {
    const entries = fs.readdirSync('.', { withFileTypes: true })
    if (entries.length > maxEntries) throw new Error('entries')
    result = { entries: entries.map((entry) => ({ name: entry.name, ...identity(fs.lstatSync(entry.name, { bigint: true })) })) }
  } else if (action === 'contents') {
    let child = null
    try { child = identity(fs.lstatSync('Contents', { bigint: true })) }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error }
    result = { child }
  } else if (action === 'package') result = { file: fixedFile('package.json', false) }
  else if (action === 'plist') result = { file: fixedFile('Info.plist', true) }
  else throw new Error('action')
  const after = fs.fstatSync(directoryFd, { bigint: true })
  const namedAfter = fs.lstatSync('.', { bigint: true })
  if (!same(before, after) || !same(before, namedAfter)) throw new Error('directory drift')
  process.stdout.write(JSON.stringify({ ok: true, ...result }))
} catch { process.stdout.write(JSON.stringify({ ok: false })) }
finally { if (directoryFd !== undefined) try { fs.closeSync(directoryFd) } catch {} }
`

export interface CurrentInventoryScanLimits {
  maxEntries: number
  maxItems: number
  maxDepth: number
  maxFileBytes: number
  maxTotalBytes: number
  timeoutMs: number
}

export interface CurrentInventoryScanOptions {
  macRoots?: string[]
  raycastRoot?: string
  limits?: Partial<CurrentInventoryScanLimits>
  now?: () => number
  beforeDirectoryBind?: (path: string, depth: number) => void | Promise<void>
  /** Test-only fault injection for the bound-file post-read identity check. */
  testMutateBoundFileBeforeFinalCheck?: boolean
}

export type ReadOnlyCommandRunner = (executable: string, args: readonly string[]) => Promise<string>

export async function runReadOnlyCommand(
  executable: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync(executable, [...args], {
    encoding: 'utf8',
    timeout: READ_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  })
  if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES || stdout.includes('\0')) {
    throw new Error('Inventory command output exceeds the supported limit')
  }
  return stdout
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function parseLines(output: string, pattern: RegExp): string[] {
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES || output.includes('\0')) {
    throw new Error('Inventory command output exceeds the supported limit')
  }
  const lines = output.split(/\r?\n/)
  if (lines.length > 50_000 || lines.some((line) => line.length > 4096)) {
    throw new Error('Inventory command output is invalid')
  }
  return [...new Set(lines.map((line) => line.trim()).filter((line) => pattern.test(line)))].sort(
    compare,
  )
}

async function collectHomebrew(
  runner: ReadOnlyCommandRunner,
): Promise<CurrentMachineInventory['homebrew']> {
  try {
    const [taps, formulae, casks] = await Promise.all([
      runner(HOMEBREW_EXECUTABLE, ['tap']),
      runner(HOMEBREW_EXECUTABLE, ['list', '--formula', '--full-name']),
      runner(HOMEBREW_EXECUTABLE, ['list', '--cask', '--full-name']),
    ])
    return {
      available: true,
      taps: parseLines(taps, BREW_IDENTIFIER),
      formulae: parseLines(formulae, BREW_IDENTIFIER),
      casks: parseLines(casks, BREW_IDENTIFIER),
    }
  } catch {
    return { available: false, taps: [], formulae: [], casks: [] }
  }
}

async function collectVSCode(
  runner: ReadOnlyCommandRunner,
): Promise<CurrentMachineInventory['vscode']> {
  for (const executable of VSCODE_EXECUTABLE_CANDIDATES) {
    try {
      return {
        available: true,
        extensions: parseLines(
          await runner(executable, ['--list-extensions']),
          VSCODE_EXTENSION_ID,
        ),
      }
    } catch {
      // The next hardcoded candidate may be present.
    }
  }
  return { available: false, extensions: [] }
}

interface ScanContext {
  limits: CurrentInventoryScanLimits
  now: () => number
  deadline: number
  entriesVisited: number
  bytesRead: number
  maxDepthVisited: number
  issues: Set<string>
  beforeDirectoryBind?: CurrentInventoryScanOptions['beforeDirectoryBind']
  testMutateBoundFileBeforeFinalCheck: boolean
}

interface BoundIdentity {
  device: string
  inode: string
  type: 'directory' | 'file' | 'symlink' | 'other'
  size: string
  modifiedAtNs: string
  changedAtNs: string
}

interface BoundEntry extends BoundIdentity {
  name: string
}

interface BoundFileResult {
  status: 'missing' | 'unsafe' | 'too-large' | 'invalid' | 'ok'
  sourceSize?: number
  payload?: string
}

interface BoundDirectoryResult {
  entries?: BoundEntry[]
  child?: BoundIdentity | null
  file?: BoundFileResult
}

function scanContext(options: CurrentInventoryScanOptions): ScanContext {
  const limits = { ...DEFAULT_SCAN_LIMITS, ...options.limits }
  if (
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1) ||
    limits.maxDepth > 64 ||
    limits.maxEntries > 100_000 ||
    limits.maxItems > 50_000 ||
    limits.maxFileBytes > 16 * 1024 * 1024 ||
    limits.maxTotalBytes > 128 * 1024 * 1024 ||
    limits.timeoutMs > 60_000
  ) {
    throw new Error('Current inventory scan limits are invalid')
  }
  const now = options.now ?? Date.now
  return {
    limits,
    now,
    deadline: now() + limits.timeoutMs,
    entriesVisited: 0,
    bytesRead: 0,
    maxDepthVisited: 0,
    issues: new Set(),
    beforeDirectoryBind: options.beforeDirectoryBind,
    testMutateBoundFileBeforeFinalCheck: options.testMutateBoundFileBeforeFinalCheck === true,
  }
}

function withinBudget(context: ScanContext, depth: number): boolean {
  context.maxDepthVisited = Math.max(context.maxDepthVisited, depth)
  let allowed = true
  if (context.now() > context.deadline) {
    context.issues.add('scan-time-limit-exceeded')
    allowed = false
  }
  if (depth > context.limits.maxDepth) {
    context.issues.add('scan-depth-limit-exceeded')
    allowed = false
  }
  if (context.entriesVisited >= context.limits.maxEntries) {
    context.issues.add('scan-entry-limit-exceeded')
    allowed = false
  }
  if (context.bytesRead > context.limits.maxTotalBytes) {
    context.issues.add('scan-byte-limit-exceeded')
    allowed = false
  }
  return allowed
}

async function lstatOrMissing(path: string) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function identityFromStat(
  stat: NonNullable<Awaited<ReturnType<typeof lstatOrMissing>>>,
): BoundIdentity {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    type: stat.isDirectory()
      ? 'directory'
      : stat.isFile()
        ? 'file'
        : stat.isSymbolicLink()
          ? 'symlink'
          : 'other',
    size: stat.size.toString(),
    modifiedAtNs: stat.mtimeNs.toString(),
    changedAtNs: stat.ctimeNs.toString(),
  }
}

function sameIdentity(left: BoundIdentity, right: BoundIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.type === right.type &&
    left.size === right.size &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs
  )
}

function parseIdentity(value: unknown): BoundIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  if (
    typeof entry.device !== 'string' ||
    !/^\d+$/.test(entry.device) ||
    typeof entry.inode !== 'string' ||
    !/^\d+$/.test(entry.inode) ||
    (entry.type !== 'directory' &&
      entry.type !== 'file' &&
      entry.type !== 'symlink' &&
      entry.type !== 'other') ||
    typeof entry.size !== 'string' ||
    !/^\d+$/.test(entry.size) ||
    typeof entry.modifiedAtNs !== 'string' ||
    !/^\d+$/.test(entry.modifiedAtNs) ||
    typeof entry.changedAtNs !== 'string' ||
    !/^\d+$/.test(entry.changedAtNs)
  )
    return null
  return entry as unknown as BoundIdentity
}

async function bindDirectory(
  path: string,
  expected: BoundIdentity,
  action: 'list' | 'contents' | 'package' | 'plist',
  depth: number,
  context: ScanContext,
): Promise<BoundDirectoryResult | null> {
  try {
    await context.beforeDirectoryBind?.(path, depth)
    const remainingMs = Math.max(1, context.deadline - context.now())
    const remainingEntries = Math.max(0, context.limits.maxEntries - context.entriesVisited)
    const maxBuffer = Math.min(
      32 * 1024 * 1024,
      Math.max(1024 * 1024, remainingEntries * 1024 + context.limits.maxFileBytes * 2 + 4096),
    )
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '-e',
        DIRECTORY_WORKER,
        expected.device,
        expected.inode,
        action,
        String(remainingEntries),
        String(context.limits.maxFileBytes),
        context.testMutateBoundFileBeforeFinalCheck ? '1' : '0',
      ],
      {
        cwd: path,
        encoding: 'utf8',
        timeout: remainingMs,
        maxBuffer,
        windowsHide: true,
      },
    )
    const parsed: unknown = JSON.parse(stdout)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('worker')
    const response = parsed as Record<string, unknown>
    if (response.ok !== true) throw new Error('worker')
    const namedAfter = await lstatOrMissing(path)
    if (!namedAfter || !sameIdentity(expected, identityFromStat(namedAfter))) {
      context.issues.add('scan-directory-drift')
      return null
    }
    const result: BoundDirectoryResult = {}
    if (action === 'list') {
      if (!Array.isArray(response.entries) || response.entries.length > remainingEntries)
        throw new Error('entries')
      const entries: BoundEntry[] = []
      for (const candidate of response.entries) {
        const identity = parseIdentity(candidate)
        const name =
          candidate && typeof candidate === 'object' && !Array.isArray(candidate)
            ? (candidate as Record<string, unknown>).name
            : null
        if (
          !identity ||
          typeof name !== 'string' ||
          name.length === 0 ||
          name === '.' ||
          name === '..' ||
          name.includes('/') ||
          name.includes('\0') ||
          Buffer.byteLength(name) > 1024
        )
          throw new Error('entry')
        entries.push({ name, ...identity })
      }
      result.entries = entries.sort((left, right) => compare(left.name, right.name))
    } else if (action === 'contents') {
      if (response.child !== null && response.child !== undefined) {
        const child = parseIdentity(response.child)
        if (!child) throw new Error('child')
        result.child = child
      } else result.child = null
    } else {
      if (!response.file || typeof response.file !== 'object' || Array.isArray(response.file))
        throw new Error('file')
      const file = response.file as Record<string, unknown>
      if (
        file.status !== 'missing' &&
        file.status !== 'unsafe' &&
        file.status !== 'too-large' &&
        file.status !== 'invalid' &&
        file.status !== 'ok'
      )
        throw new Error('file')
      if (
        file.status === 'ok' &&
        (!Number.isSafeInteger(file.sourceSize) ||
          (file.sourceSize as number) < 0 ||
          (file.sourceSize as number) > context.limits.maxFileBytes ||
          typeof file.payload !== 'string' ||
          Buffer.byteLength(file.payload) > context.limits.maxFileBytes * 2)
      )
        throw new Error('file')
      result.file = file as unknown as BoundFileResult
    }
    return result
  } catch {
    context.issues.add('scan-directory-read-failed')
    return null
  }
}

function metadataString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= 512 && !normalized.includes('\0') ? normalized : null
}

function decodeBoundFile(file: BoundFileResult, context: ScanContext): Buffer | null {
  if (file.status !== 'ok' || file.sourceSize === undefined || file.payload === undefined)
    return null
  const payload = Buffer.from(file.payload, 'base64')
  context.bytesRead += file.sourceSize
  if (context.bytesRead > context.limits.maxTotalBytes) {
    context.issues.add('scan-byte-limit-exceeded')
    payload.fill(0)
    return null
  }
  return payload
}

export async function scanBoundedMacApplications(
  options: CurrentInventoryScanOptions = {},
): Promise<CurrentMachineInventory['macApps']> {
  const context = scanContext(options)
  const apps: CurrentMachineInventory['macApps']['items'] = []
  const walk = async (directory: string, expected: BoundIdentity, depth: number): Promise<void> => {
    if (!withinBudget(context, depth)) return
    const bound = await bindDirectory(directory, expected, 'list', depth, context)
    if (!bound?.entries) return
    for (const entry of bound.entries) {
      if (!withinBudget(context, depth)) break
      context.entriesVisited += 1
      if (entry.type === 'symlink') {
        context.issues.add('scan-symlink-skipped')
        continue
      }
      if (entry.type !== 'directory') continue
      const path = join(directory, entry.name)
      if (entry.name.endsWith('.app')) {
        if (apps.length >= context.limits.maxItems) {
          context.issues.add('scan-item-limit-exceeded')
          break
        }
        let plist: Record<string, unknown> | null = null
        const app = await bindDirectory(path, entry, 'contents', depth + 1, context)
        const contents = app?.child
        if (contents?.type === 'directory') {
          const held = await bindDirectory(
            join(path, 'Contents'),
            contents,
            'plist',
            depth + 2,
            context,
          )
          const file = held?.file
          if (file?.status === 'too-large') context.issues.add('scan-file-size-limit-exceeded')
          else if (file?.status === 'unsafe') context.issues.add('mac-app-plist-unsafe')
          else if (file?.status === 'invalid') context.issues.add('mac-app-plist-invalid')
          else if (file?.status === 'ok') {
            const payload = decodeBoundFile(file, context)
            if (payload) {
              try {
                const parsed: unknown = JSON.parse(payload.toString('utf8'))
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                  throw new Error('plist')
                plist = parsed as Record<string, unknown>
              } catch {
                context.issues.add('mac-app-plist-invalid')
              } finally {
                payload.fill(0)
              }
            }
          }
        } else if (contents) context.issues.add('mac-app-contents-unsafe')
        apps.push({
          name:
            metadataString(plist?.CFBundleName) ??
            metadataString(plist?.CFBundleDisplayName) ??
            basename(path, '.app'),
          bundleId: metadataString(plist?.CFBundleIdentifier),
          path,
        })
        continue
      }
      await walk(path, entry, depth + 1)
    }
  }
  for (const scanRoot of options.macRoots ?? DEFAULT_MAC_ROOTS) {
    const root = resolve(scanRoot)
    try {
      const stat = await lstatOrMissing(root)
      if (!stat) continue
      const identity = identityFromStat(stat)
      if (identity.type !== 'directory') context.issues.add('scan-directory-unsafe')
      else await walk(root, identity, 0)
    } catch {
      context.issues.add('scan-directory-read-failed')
    }
  }
  const byIdentity = new Map<string, (typeof apps)[number]>()
  for (const app of apps) byIdentity.set(app.bundleId ?? app.path, app)
  return {
    items: [...byIdentity.values()].sort((left, right) => compare(left.name, right.name)),
    complete: context.issues.size === 0,
    entriesVisited: context.entriesVisited,
    bytesRead: context.bytesRead,
    maxDepthVisited: context.maxDepthVisited,
    issues: [...context.issues].sort(compare),
  }
}

export async function scanBoundedRaycastExtensions(
  options: CurrentInventoryScanOptions = {},
): Promise<CurrentMachineInventory['raycastExtensions']> {
  const context = scanContext(options)
  const items: CurrentMachineInventory['raycastExtensions']['items'] = []
  const root = resolve(options.raycastRoot ?? DEFAULT_RAYCAST_ROOT)
  try {
    const stat = await lstatOrMissing(root)
    if (!stat)
      return {
        items,
        complete: true,
        entriesVisited: 0,
        bytesRead: 0,
        maxDepthVisited: 0,
        issues: [],
      }
    const rootIdentity = identityFromStat(stat)
    if (rootIdentity.type !== 'directory') context.issues.add('scan-directory-unsafe')
    else {
      const bound = await bindDirectory(root, rootIdentity, 'list', 0, context)
      for (const entry of bound?.entries ?? []) {
        if (!withinBudget(context, 1)) break
        context.entriesVisited += 1
        if (entry.type === 'symlink') {
          context.issues.add('scan-symlink-skipped')
          continue
        }
        if (entry.type !== 'directory') continue
        if (items.length >= context.limits.maxItems) {
          context.issues.add('scan-item-limit-exceeded')
          break
        }
        let title: string | null = null
        const extension = await bindDirectory(join(root, entry.name), entry, 'package', 1, context)
        const file = extension?.file
        if (file?.status === 'unsafe' || file?.status === 'too-large')
          context.issues.add('raycast-package-unsafe')
        else if (file?.status === 'invalid') context.issues.add('raycast-package-invalid')
        else if (file?.status === 'ok') {
          const payload = decodeBoundFile(file, context)
          if (payload) {
            try {
              const parsed: unknown = JSON.parse(payload.toString('utf8'))
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('package')
              title = metadataString((parsed as Record<string, unknown>).title)
            } catch {
              context.issues.add('raycast-package-invalid')
            } finally {
              payload.fill(0)
            }
          }
        }
        items.push({ id: entry.name, title })
      }
    }
  } catch {
    context.issues.add('scan-directory-read-failed')
  }
  return {
    items: items.sort((left, right) => compare(left.id, right.id)),
    complete: context.issues.size === 0,
    entriesVisited: context.entriesVisited,
    bytesRead: context.bytesRead,
    maxDepthVisited: context.maxDepthVisited,
    issues: [...context.issues].sort(compare),
  }
}

export async function collectCurrentMachineInventory(
  runner: ReadOnlyCommandRunner = runReadOnlyCommand,
  scanOptions: CurrentInventoryScanOptions = {},
): Promise<CurrentMachineInventory> {
  const [homebrew, vscode, macApps, raycastExtensions] = await Promise.all([
    collectHomebrew(runner),
    collectVSCode(runner),
    scanBoundedMacApplications(scanOptions),
    scanBoundedRaycastExtensions(scanOptions),
  ])
  return {
    homebrew,
    vscode,
    macApps,
    raycastExtensions,
  }
}

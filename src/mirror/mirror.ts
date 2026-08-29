import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { CapturePlan, ResolvedSource } from '../catalog/types.js'
import { fileHash } from '../util/hash.js'

export const MIRROR_MANIFEST_NAME = '.restore-manifest.json'

const IdentifierSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/)
const MirrorSourceSchema = z
  .object({
    id: z.string().min(1).max(201),
    plugin: IdentifierSchema,
    name: IdentifierSchema,
    declaredPath: z.string().min(1).max(4096),
    exclude: z.array(z.string().min(1).max(4096)).max(256).default([]),
    status: z.enum(['present', 'missing']),
  })
  .strict()
const MirrorEntrySchema = z
  .object({
    sourceId: z.string().min(1).max(201),
    relativePath: z.string().min(1).max(4096),
    type: z.enum(['file', 'directory', 'symlink']),
    mode: z.number().int().min(0).max(0o7777),
    size: z.number().int().nonnegative().optional(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    linkTarget: z.string().max(4096).optional(),
  })
  .strict()
const MirrorManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    sources: z.array(MirrorSourceSchema).max(256),
    entries: z.array(MirrorEntrySchema).max(1_000_000),
  })
  .strict()

export interface MirrorSource {
  id: string
  plugin: string
  name: string
  declaredPath: string
  exclude: string[]
  status: 'present' | 'missing'
}

export interface MirrorEntry {
  sourceId: string
  relativePath: string
  type: 'file' | 'directory' | 'symlink'
  mode: number
  size?: number
  sha256?: string
  linkTarget?: string
}

export interface MirrorManifest {
  formatVersion: 1
  generatedAt: string
  sources: MirrorSource[]
  entries: MirrorEntry[]
}

export interface MirrorDiff {
  action: 'create' | 'modify' | 'delete'
  sourceId: string
  relativePath: string
  type: MirrorEntry['type']
}

export class MirrorError extends Error {
  readonly code: string
  readonly category: 'configuration' | 'source' | 'destination' | 'integrity'

  constructor(code: string, category: MirrorError['category'], message: string) {
    super(message)
    this.name = 'MirrorError'
    this.code = code
    this.category = category
  }
}

function safeRelativePath(value: string): string {
  if (
    value === '.' ||
    (!value.includes('\0') &&
      !isAbsolute(value) &&
      !value.split(/[\\/]/).includes('..') &&
      value !== '')
  ) {
    return value
  }
  throw new MirrorError('INVALID_MIRROR_MANIFEST', 'integrity', 'Mirror path is unsafe')
}

function mode(metadata: Awaited<ReturnType<typeof lstat>>): number {
  return Number(metadata.mode) & 0o7777
}

function entryKey(entry: Pick<MirrorEntry, 'sourceId' | 'relativePath'>): string {
  return `${entry.sourceId}\0${entry.relativePath}`
}

function pathDepth(value: string): number {
  return value === '.' ? 0 : value.split('/').length
}

function sourceMirrorPath(root: string, source: Pick<MirrorSource, 'plugin' | 'name'>): string {
  return join(root, source.plugin, source.name)
}

function entryPath(root: string, source: MirrorSource, relativePath: string): string {
  const base = sourceMirrorPath(root, source)
  return relativePath === '.' ? base : join(base, safeRelativePath(relativePath))
}

function sourceEntryPath(source: ResolvedSource, relativePath: string): string {
  return relativePath === '.' ? source.path : join(source.path, safeRelativePath(relativePath))
}

function isExcluded(source: ResolvedSource, relativePath: string): boolean {
  return source.exclude.some(
    (excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`),
  )
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

function actualType(
  metadata: Awaited<ReturnType<typeof lstat>>,
): MirrorEntry['type'] | 'unsupported' {
  if (metadata.isFile()) return 'file'
  if (metadata.isDirectory()) return 'directory'
  if (metadata.isSymbolicLink()) return 'symlink'
  return 'unsupported'
}

async function scanEntry(
  source: ResolvedSource,
  path: string,
  relativePath: string,
  entries: MirrorEntry[],
): Promise<void> {
  const before = await lstat(path)
  const type = actualType(before)
  if (type === 'unsupported') {
    throw new MirrorError('UNSUPPORTED_SOURCE_TYPE', 'source', `Unsupported source: ${source.id}`)
  }

  if (type === 'file') {
    const sha256 = await fileHash(path)
    const after = await lstat(path)
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new MirrorError(
        'SOURCE_CHANGED',
        'source',
        `Source changed while reading: ${source.id}`,
      )
    }
    entries.push({
      sourceId: source.id,
      relativePath,
      type,
      mode: mode(after),
      size: after.size,
      sha256,
    })
    return
  }

  if (type === 'symlink') {
    const linkTarget = await readlink(path)
    const after = await lstat(path)
    if (!after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new MirrorError(
        'SOURCE_CHANGED',
        'source',
        `Source changed while reading: ${source.id}`,
      )
    }
    entries.push({ sourceId: source.id, relativePath, type, mode: mode(after), linkTarget })
    return
  }

  entries.push({ sourceId: source.id, relativePath, type, mode: mode(before) })
  const names = (await readdir(path)).sort()
  for (const name of names) {
    const childRelative = relativePath === '.' ? name : `${relativePath}/${name}`
    if (!isExcluded(source, childRelative)) {
      await scanEntry(source, join(path, name), childRelative, entries)
    }
  }
  const after = await lstat(path)
  if (
    !after.isDirectory() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new MirrorError('SOURCE_CHANGED', 'source', `Source changed while reading: ${source.id}`)
  }
}

export async function scanSources(
  plan: CapturePlan,
  options: { allowRequiredMissing?: boolean; now?: () => Date } = {},
): Promise<MirrorManifest> {
  const sources: MirrorSource[] = []
  const entries: MirrorEntry[] = []
  for (const source of plan.sources) {
    let metadata: Awaited<ReturnType<typeof lstat>>
    try {
      metadata = await lstat(source.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (source.requirement === 'required' && !options.allowRequiredMissing) {
        throw new MirrorError(
          'REQUIRED_SOURCE_MISSING',
          'source',
          `Required source is missing: ${source.id}`,
        )
      }
      sources.push({
        id: source.id,
        plugin: source.plugin,
        name: source.name,
        declaredPath: source.declaredPath,
        exclude: source.exclude,
        status: 'missing',
      })
      continue
    }
    if (actualType(metadata) === 'unsupported') {
      throw new MirrorError('UNSUPPORTED_SOURCE_TYPE', 'source', `Unsupported source: ${source.id}`)
    }
    sources.push({
      id: source.id,
      plugin: source.plugin,
      name: source.name,
      declaredPath: source.declaredPath,
      exclude: source.exclude,
      status: 'present',
    })
    await scanEntry(source, source.path, '.', entries)
  }
  entries.sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.relativePath.localeCompare(right.relativePath),
  )
  return {
    formatVersion: 1,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    sources,
    entries,
  }
}

function validateManifest(value: unknown): MirrorManifest {
  const manifest = MirrorManifestSchema.parse(value) as MirrorManifest
  const sourceIds = new Set<string>()
  for (const source of manifest.sources) {
    if (source.id !== `${source.plugin}:${source.name}` || sourceIds.has(source.id)) {
      throw new MirrorError('INVALID_MIRROR_MANIFEST', 'integrity', 'Mirror sources are invalid')
    }
    sourceIds.add(source.id)
  }
  const keys = new Set<string>()
  for (const entry of manifest.entries) {
    safeRelativePath(entry.relativePath)
    const key = entryKey(entry)
    if (!sourceIds.has(entry.sourceId) || keys.has(key)) {
      throw new MirrorError('INVALID_MIRROR_MANIFEST', 'integrity', 'Mirror entries are invalid')
    }
    keys.add(key)
    if (
      (entry.type === 'file' &&
        (entry.size === undefined ||
          entry.sha256 === undefined ||
          entry.linkTarget !== undefined)) ||
      (entry.type === 'symlink' &&
        (entry.linkTarget === undefined ||
          entry.size !== undefined ||
          entry.sha256 !== undefined)) ||
      (entry.type === 'directory' &&
        (entry.size !== undefined || entry.sha256 !== undefined || entry.linkTarget !== undefined))
    ) {
      throw new MirrorError('INVALID_MIRROR_MANIFEST', 'integrity', 'Mirror entry shape is invalid')
    }
  }
  for (const source of manifest.sources) {
    const sourceEntries = manifest.entries.filter((entry) => entry.sourceId === source.id)
    if (
      (source.status === 'missing' && sourceEntries.length > 0) ||
      (source.status === 'present' && !sourceEntries.some((entry) => entry.relativePath === '.'))
    ) {
      throw new MirrorError(
        'INVALID_MIRROR_MANIFEST',
        'integrity',
        'Mirror source status is invalid',
      )
    }
  }
  return manifest
}

export async function readMirrorManifest(root: string): Promise<MirrorManifest> {
  let rootMetadata: Awaited<ReturnType<typeof lstat>>
  try {
    rootMetadata = await lstat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MirrorError('MIRROR_NOT_FOUND', 'destination', 'Mirror does not exist')
    }
    throw error
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new MirrorError('INVALID_MIRROR_ROOT', 'integrity', 'Mirror root is not a directory')
  }
  const manifestPath = join(root, MIRROR_MANIFEST_NAME)
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(manifestPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MirrorError(
        'LEGACY_REPOSITORY_PRESENT',
        'configuration',
        'Destination contains the old repository format',
      )
    }
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) {
    throw new MirrorError('INVALID_MIRROR_MANIFEST', 'integrity', 'Mirror manifest is unsafe')
  }
  try {
    return validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  } catch (error) {
    if (error instanceof MirrorError) throw error
    throw new MirrorError('INVALID_MIRROR_MANIFEST', 'integrity', 'Mirror manifest is invalid')
  }
}

function entrySignature(entry: MirrorEntry): string {
  return JSON.stringify({
    type: entry.type,
    mode: entry.mode,
    size: entry.size ?? null,
    sha256: entry.sha256 ?? null,
    linkTarget: entry.linkTarget ?? null,
  })
}

export function diffManifests(
  current: MirrorManifest | null,
  desired: MirrorManifest,
): MirrorDiff[] {
  const currentEntries = new Map((current?.entries ?? []).map((entry) => [entryKey(entry), entry]))
  const desiredEntries = new Map(desired.entries.map((entry) => [entryKey(entry), entry]))
  const diff: MirrorDiff[] = []
  for (const [key, entry] of desiredEntries) {
    const previous = currentEntries.get(key)
    if (!previous)
      diff.push({
        action: 'create',
        sourceId: entry.sourceId,
        relativePath: entry.relativePath,
        type: entry.type,
      })
    else if (entrySignature(previous) !== entrySignature(entry)) {
      diff.push({
        action: 'modify',
        sourceId: entry.sourceId,
        relativePath: entry.relativePath,
        type: entry.type,
      })
    }
  }
  for (const [key, entry] of currentEntries) {
    if (!desiredEntries.has(key)) {
      diff.push({
        action: 'delete',
        sourceId: entry.sourceId,
        relativePath: entry.relativePath,
        type: entry.type,
      })
    }
  }
  return diff.sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.relativePath.localeCompare(right.relativePath) ||
      left.action.localeCompare(right.action),
  )
}

function assertPlanMatchesManifest(plan: CapturePlan, manifest: MirrorManifest): void {
  const planned = plan.sources
    .map((source) => `${source.id}\0${source.declaredPath}\0${JSON.stringify(source.exclude)}`)
    .sort()
  const recorded = manifest.sources
    .map((source) => `${source.id}\0${source.declaredPath}\0${JSON.stringify(source.exclude)}`)
    .sort()
  if (JSON.stringify(planned) !== JSON.stringify(recorded)) {
    throw new MirrorError(
      'MIRROR_CONFIG_MISMATCH',
      'configuration',
      'Mirror sources do not match the current configuration',
    )
  }
}

async function writeMirrorTree(
  root: string,
  plan: CapturePlan,
  manifest: MirrorManifest,
  onProgress?: (message: string) => void,
): Promise<void> {
  const sourceById = new Map(plan.sources.map((source) => [source.id, source]))
  const recordById = new Map(manifest.sources.map((source) => [source.id, source]))
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directories = manifest.entries
    .filter((entry) => entry.type === 'directory')
    .sort((left, right) => pathDepth(left.relativePath) - pathDepth(right.relativePath))
  for (const entry of directories) {
    const record = recordById.get(entry.sourceId)
    if (!record)
      throw new MirrorError('INVALID_MIRROR_MANIFEST', 'integrity', 'Mirror source is missing')
    const destination = entryPath(root, record, entry.relativePath)
    await mkdir(destination, { recursive: true, mode: entry.mode })
  }

  const writable = manifest.entries.filter((entry) => entry.type !== 'directory')
  let written = 0
  for (const entry of writable) {
    const source = sourceById.get(entry.sourceId)
    const record = recordById.get(entry.sourceId)
    if (!source || !record) {
      throw new MirrorError('MIRROR_CONFIG_MISMATCH', 'configuration', 'Mirror source is missing')
    }
    const sourcePath = sourceEntryPath(source, entry.relativePath)
    const destination = entryPath(root, record, entry.relativePath)
    await mkdir(dirname(destination), { recursive: true })
    if (entry.type === 'file') {
      if ((await fileHash(sourcePath)) !== entry.sha256) {
        throw new MirrorError(
          'SOURCE_CHANGED',
          'source',
          `Source changed while copying: ${source.id}`,
        )
      }
      await copyFile(sourcePath, destination)
      if ((await fileHash(destination)) !== entry.sha256) {
        throw new MirrorError(
          'MIRROR_WRITE_FAILED',
          'destination',
          `Copied file did not verify: ${source.id}`,
        )
      }
      await chmod(destination, entry.mode)
    } else {
      const target = await readlink(sourcePath)
      if (target !== entry.linkTarget) {
        throw new MirrorError(
          'SOURCE_CHANGED',
          'source',
          `Source changed while copying: ${source.id}`,
        )
      }
      await symlink(target, destination)
    }
    written++
    onProgress?.(`Writing mirror · ${written}/${writable.length}`)
  }
  for (const entry of [...directories].reverse()) {
    const record = recordById.get(entry.sourceId)
    if (record) await chmod(entryPath(root, record, entry.relativePath), entry.mode)
  }
  await writeFile(join(root, MIRROR_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

async function actualMirrorPaths(root: string): Promise<Set<string>> {
  const paths = new Set<string>()
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === '.DS_Store' || (directory === root && name === MIRROR_MANIFEST_NAME)) continue
      const path = join(directory, name)
      const relativePath = relative(root, path).split(sep).join('/')
      paths.add(relativePath)
      const metadata = await lstat(path)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await walk(path)
    }
  }
  await walk(root)
  return paths
}

function expectedMirrorPaths(root: string, manifest: MirrorManifest): Set<string> {
  const paths = new Set<string>()
  for (const source of manifest.sources.filter((source) => source.status === 'present')) {
    paths.add(source.plugin)
  }
  for (const entry of manifest.entries) {
    const source = manifest.sources.find((candidate) => candidate.id === entry.sourceId)
    if (source)
      paths.add(
        relative(root, entryPath(root, source, entry.relativePath))
          .split(sep)
          .join('/'),
      )
  }
  return paths
}

export async function verifyMirror(root: string): Promise<MirrorManifest> {
  const manifest = await readMirrorManifest(root)
  const sourceById = new Map(manifest.sources.map((source) => [source.id, source]))
  const expectedPaths = expectedMirrorPaths(root, manifest)
  for (const entry of manifest.entries) {
    const source = sourceById.get(entry.sourceId)
    if (!source)
      throw new MirrorError('INVALID_MIRROR_MANIFEST', 'integrity', 'Mirror source is missing')
    const path = entryPath(root, source, entry.relativePath)
    let metadata: Awaited<ReturnType<typeof lstat>>
    try {
      metadata = await lstat(path)
    } catch {
      throw new MirrorError(
        'MIRROR_ENTRY_MISSING',
        'integrity',
        `Mirror entry is missing: ${entry.sourceId}`,
      )
    }
    if (actualType(metadata) !== entry.type || mode(metadata) !== entry.mode) {
      throw new MirrorError(
        'MIRROR_ENTRY_MISMATCH',
        'integrity',
        `Mirror entry changed: ${entry.sourceId}`,
      )
    }
    if (
      (entry.type === 'file' &&
        (metadata.size !== entry.size || (await fileHash(path)) !== entry.sha256)) ||
      (entry.type === 'symlink' && (await readlink(path)) !== entry.linkTarget)
    ) {
      throw new MirrorError(
        'MIRROR_ENTRY_MISMATCH',
        'integrity',
        `Mirror content changed: ${entry.sourceId}`,
      )
    }
  }
  const actualPaths = await actualMirrorPaths(root)
  if (
    actualPaths.size !== expectedPaths.size ||
    [...actualPaths].some((path) => !expectedPaths.has(path))
  ) {
    throw new MirrorError(
      'MIRROR_LAYOUT_MISMATCH',
      'integrity',
      'Mirror contains unexpected entries',
    )
  }
  return manifest
}

async function copyPendingEntry(
  pending: string,
  root: string,
  source: MirrorSource,
  entry: MirrorEntry,
): Promise<void> {
  const from = entryPath(pending, source, entry.relativePath)
  const to = entryPath(root, source, entry.relativePath)
  const temporary = `${to}.restore-${randomUUID()}`
  await mkdir(dirname(to), { recursive: true })
  try {
    if (entry.type === 'file') {
      await copyFile(from, temporary)
      await chmod(temporary, entry.mode)
    } else {
      await symlink(await readlink(from), temporary)
    }
    await rm(to, { recursive: true, force: true })
    await rename(temporary, to)
  } finally {
    if (await exists(temporary)) await rm(temporary, { recursive: true, force: true })
  }
}

async function publishInPlace(
  root: string,
  pending: string,
  manifest: MirrorManifest,
  diff: readonly MirrorDiff[],
  refreshAll: boolean,
  onPhase?: (message: string) => void,
): Promise<void> {
  onPhase?.('Updating mirror in place')
  if (await exists(root)) {
    const metadata = await lstat(root)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      await rm(root, { recursive: true, force: true })
    }
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  const expected = expectedMirrorPaths(root, manifest)
  const actual = await actualMirrorPaths(root)
  const stale = [...actual]
    .filter((path) => !expected.has(path))
    .sort((left, right) => pathDepth(right) - pathDepth(left))
  for (const path of stale) await rm(join(root, path), { recursive: true, force: true })

  const sources = new Map(manifest.sources.map((source) => [source.id, source]))
  for (const source of manifest.sources.filter((source) => source.status === 'present')) {
    await mkdir(join(root, source.plugin), { recursive: true, mode: 0o700 })
  }
  const directories = manifest.entries
    .filter((entry) => entry.type === 'directory')
    .sort((left, right) => pathDepth(left.relativePath) - pathDepth(right.relativePath))
  for (const entry of directories) {
    const source = sources.get(entry.sourceId)
    if (!source) continue
    const path = entryPath(root, source, entry.relativePath)
    if ((await exists(path)) && !(await lstat(path)).isDirectory()) {
      await rm(path, { recursive: true, force: true })
    }
    await mkdir(path, { recursive: true, mode: entry.mode })
  }

  const changed = new Set(
    diff.filter((entry) => entry.action !== 'delete').map((entry) => entryKey(entry)),
  )
  for (const entry of manifest.entries.filter((entry) => entry.type !== 'directory')) {
    if (!refreshAll && !changed.has(entryKey(entry))) continue
    const source = sources.get(entry.sourceId)
    if (source) await copyPendingEntry(pending, root, source, entry)
  }
  for (const entry of [...directories].reverse()) {
    const source = sources.get(entry.sourceId)
    if (source) await chmod(entryPath(root, source, entry.relativePath), entry.mode)
  }

  const manifestPath = join(root, MIRROR_MANIFEST_NAME)
  const temporaryManifest = `${manifestPath}.restore-${randomUUID()}`
  await copyFile(join(pending, MIRROR_MANIFEST_NAME), temporaryManifest)
  await chmod(temporaryManifest, 0o600)
  await rm(manifestPath, { force: true })
  await rename(temporaryManifest, manifestPath)
}

export interface SynchronizeMirrorOptions {
  root: string
  plan: CapturePlan
  dryRun: boolean
  replaceLegacy?: boolean
  onPhase?: (message: string) => void
}

export async function synchronizeMirror(options: SynchronizeMirrorOptions): Promise<{
  manifest: MirrorManifest
  diff: MirrorDiff[]
  changed: boolean
  replacedLegacy: boolean
  repaired: boolean
}> {
  options.onPhase?.('Scanning current sources')
  const manifest = await scanSources(options.plan)
  let current: MirrorManifest | null = null
  let replacedLegacy = false
  let repaired = false
  if (await exists(options.root)) {
    try {
      current = await verifyMirror(options.root)
    } catch (error) {
      if (!(error instanceof MirrorError)) throw error
      if (error.code === 'LEGACY_REPOSITORY_PRESENT') {
        if (!options.replaceLegacy) throw error
        replacedLegacy = true
      } else if (error.category === 'integrity') {
        repaired = true
        current = await readMirrorManifest(options.root).catch(() => null)
      } else {
        throw error
      }
    }
  }
  const diff = diffManifests(current, manifest)
  if (options.dryRun || (diff.length === 0 && !replacedLegacy && !repaired)) {
    return { manifest, diff, changed: false, replacedLegacy, repaired }
  }

  const pending = await mkdtemp(join(tmpdir(), 'restore-mirror-'))
  try {
    options.onPhase?.('Building verified mirror')
    await writeMirrorTree(pending, options.plan, manifest, options.onPhase)
    await verifyMirror(pending)
    options.onPhase?.('Confirming sources are unchanged')
    const rebound = await scanSources(options.plan)
    if (diffManifests(manifest, rebound).length > 0) {
      throw new MirrorError('SOURCE_CHANGED', 'source', 'Sources changed during synchronization')
    }
    await publishInPlace(
      options.root,
      pending,
      manifest,
      diff,
      replacedLegacy || repaired,
      options.onPhase,
    )
    await verifyMirror(options.root)
    return { manifest, diff, changed: true, replacedLegacy, repaired }
  } finally {
    await rm(pending, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function inspectMirror(
  root: string,
  plan: CapturePlan,
): Promise<{
  manifest: MirrorManifest
  current: MirrorManifest
  diff: MirrorDiff[]
}> {
  const manifest = await verifyMirror(root)
  assertPlanMatchesManifest(plan, manifest)
  const current = await scanSources(plan, { allowRequiredMissing: true })
  return { manifest, current, diff: diffManifests(current, manifest) }
}

async function replaceSource(
  source: ResolvedSource,
  record: MirrorSource,
  mirrorRoot: string,
): Promise<void> {
  if (record.status === 'missing') {
    await rm(source.path, { recursive: true, force: true })
    return
  }
  await mkdir(dirname(source.path), { recursive: true })
  const token = randomUUID()
  const pending = join(dirname(source.path), `.${basename(source.path)}.restore-${token}`)
  const previous = join(dirname(source.path), `.${basename(source.path)}.previous-${token}`)
  const mirrorSource = sourceMirrorPath(mirrorRoot, record)
  try {
    await cp(mirrorSource, pending, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    })
    const hadPrevious = await exists(source.path)
    if (hadPrevious) await rename(source.path, previous)
    try {
      await rename(pending, source.path)
    } catch (error) {
      if (hadPrevious) await rename(previous, source.path).catch(() => undefined)
      throw error
    }
    if (hadPrevious) await rm(previous, { recursive: true, force: true })
  } finally {
    if (await exists(pending)) await rm(pending, { recursive: true, force: true })
  }
}

export async function restoreMirror(
  root: string,
  plan: CapturePlan,
  onPhase?: (message: string) => void,
): Promise<MirrorDiff[]> {
  const inspected = await inspectMirror(root, plan)
  if (inspected.diff.length === 0) return []
  const sourceById = new Map(plan.sources.map((source) => [source.id, source]))
  const recordById = new Map(inspected.manifest.sources.map((source) => [source.id, source]))
  const affectedSources = [...new Set(inspected.diff.map((entry) => entry.sourceId))].sort()
  for (const [index, sourceId] of affectedSources.entries()) {
    const source = sourceById.get(sourceId)
    const record = recordById.get(sourceId)
    if (!source || !record) {
      throw new MirrorError(
        'MIRROR_CONFIG_MISMATCH',
        'configuration',
        'Mirror source is not configured',
      )
    }
    onPhase?.(`Restoring sources · ${index + 1}/${affectedSources.length}`)
    await replaceSource(source, record, root)
  }
  const verified = await scanSources(plan, { allowRequiredMissing: true })
  if (diffManifests(verified, inspected.manifest).length > 0) {
    throw new MirrorError(
      'RESTORE_VERIFICATION_FAILED',
      'integrity',
      'Restored sources do not match the mirror',
    )
  }
  return inspected.diff
}

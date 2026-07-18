import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { normalizePluginManifest } from '../plugin/schema.js'
import type { PluginManifest } from '../plugin/types.js'
import type { CapturePlan, ResolvedSource } from './types.js'

export class SourceScopeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SourceScopeError'
    this.code = code
  }
}

function expandDeclaredPath(path: string, home: string): string {
  if (path.includes('\0')) {
    throw new SourceScopeError('INVALID_SOURCE_PATH', 'Source path contains an invalid byte')
  }
  if (path.split(/[\\/]/).includes('..')) {
    throw new SourceScopeError('SOURCE_PATH_ESCAPE', 'Source path may not contain .. segments')
  }
  if (path === '~') return resolve(home)
  if (path.startsWith('~/')) return resolve(home, path.slice(2))
  if (!isAbsolute(path)) {
    throw new SourceScopeError(
      'INVALID_SOURCE_PATH',
      'Source path must be absolute or start with ~/',
    )
  }
  return resolve(path)
}

function assertParentsDoNotRedirect(path: string): void {
  const parent = dirname(path)
  const allowedSystemAliases = new Set(['/etc', '/tmp', '/var'])
  let current = resolve('/')
  for (const component of parent.split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      if (lstatSync(current).isSymbolicLink() && !allowedSystemAliases.has(current)) {
        throw new SourceScopeError(
          'SOURCE_PARENT_SYMLINK',
          'Source path has a symbolic-link parent; declare the resolved path explicitly',
        )
      }
    } catch (error) {
      if (error instanceof SourceScopeError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw new SourceScopeError('INVALID_SOURCE_PATH', 'Source parent cannot be inspected')
    }
  }
}

function typeOf(path: string): 'file' | 'directory' | 'symlink' | 'special' | 'missing' {
  try {
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) return 'symlink'
    if (metadata.isFile()) return 'file'
    if (metadata.isDirectory()) return 'directory'
    return 'special'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw new SourceScopeError('INVALID_SOURCE_PATH', 'Source path cannot be inspected')
  }
}

interface ScopeIdentity {
  path: string
  foldedPath: string
  inode?: string
}

function canonicalMissingPath(path: string): string {
  const suffix: string[] = []
  let current = resolve(path)
  while (current !== resolve('/')) {
    try {
      return join(realpathSync(current), ...suffix.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SourceScopeError('INVALID_SOURCE_PATH', 'Source path cannot be canonicalized')
      }
      suffix.push(basename(current))
      current = dirname(current)
    }
  }
  return join(realpathSync(resolve('/')), ...suffix.reverse())
}

function canonicalScopeIdentity(path: string): ScopeIdentity {
  let metadata: ReturnType<typeof lstatSync> | undefined
  let canonical: string
  try {
    metadata = lstatSync(path)
    canonical = metadata.isSymbolicLink()
      ? join(realpathSync(dirname(path)), basename(path))
      : realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SourceScopeError('INVALID_SOURCE_PATH', 'Source path cannot be canonicalized')
    }
    canonical = canonicalMissingPath(path)
  }
  return {
    path: canonical,
    foldedPath: canonical.normalize('NFC').toLocaleLowerCase('en-US'),
    ...(metadata ? { inode: `${metadata.dev}:${metadata.ino}` } : {}),
  }
}

function isSameOrInside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child)
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..')
}

export function buildCapturePlan(
  plugins: PluginManifest[],
  options: { home?: string; forbiddenPaths?: string[] } = {},
): CapturePlan {
  const home = canonicalScopeIdentity(resolve(options.home ?? process.env.HOME ?? homedir())).path
  const forbidden = (options.forbiddenPaths ?? []).map((path) => canonicalScopeIdentity(path))
  const normalizedPlugins = plugins.map(normalizePluginManifest)
  const sources: ResolvedSource[] = []
  const sourceIds = new Set<string>()

  for (const plugin of normalizedPlugins) {
    for (const source of plugin.sources) {
      const id = `${plugin.name}:${source.name}`
      if (sourceIds.has(id)) {
        throw new SourceScopeError('DUPLICATE_SOURCE', `Source is duplicated: ${id}`)
      }
      sourceIds.add(id)
      const expandedPath = expandDeclaredPath(source.path, home)
      if (expandedPath === resolve('/') || expandedPath === home) {
        throw new SourceScopeError(
          'DANGEROUS_SOURCE_ROOT',
          'Filesystem root and the complete home directory are not valid source scopes',
        )
      }
      assertParentsDoNotRedirect(expandedPath)
      const identity = canonicalScopeIdentity(expandedPath)
      const path = identity.path
      if (path === resolve('/') || path === home) {
        throw new SourceScopeError(
          'DANGEROUS_SOURCE_ROOT',
          'Filesystem root and the complete home directory are not valid source scopes',
        )
      }
      const actualType = typeOf(path)
      if (actualType === 'special') {
        throw new SourceScopeError('UNSUPPORTED_SOURCE_TYPE', `Source ${id} is a special file`)
      }
      if (
        actualType !== 'missing' &&
        source.expectedType !== 'any' &&
        actualType !== source.expectedType
      ) {
        throw new SourceScopeError(
          'SOURCE_TYPE_MISMATCH',
          `Source ${id} does not match expected type ${source.expectedType}`,
        )
      }
      sources.push({
        id,
        plugin: plugin.name,
        name: source.name,
        declaredPath: source.path,
        path,
        requirement: source.requirement,
        sensitivity: source.sensitivity,
        expectedType: source.expectedType,
        recoveryScope: source.recoveryScope,
        ...(source.consistencyGroup ? { consistencyGroup: source.consistencyGroup } : {}),
        includeEmptyDirectories: source.includeEmptyDirectories ?? false,
      })
      for (const denied of forbidden) {
        if (
          isSameOrInside(denied.foldedPath, identity.foldedPath) ||
          isSameOrInside(identity.foldedPath, denied.foldedPath) ||
          (identity.inode !== undefined && identity.inode === denied.inode)
        ) {
          throw new SourceScopeError(
            'SOURCE_REPOSITORY_OVERLAP',
            `Source overlaps the repository scope: ${id}`,
          )
        }
      }
    }
  }

  sources.sort(
    (left, right) =>
      left.plugin.localeCompare(right.plugin) ||
      left.name.localeCompare(right.name) ||
      left.path.localeCompare(right.path),
  )
  for (let index = 0; index < sources.length; index++) {
    for (let otherIndex = index + 1; otherIndex < sources.length; otherIndex++) {
      const left = sources[index]
      const right = sources[otherIndex]
      const leftIdentity = canonicalScopeIdentity(left.path)
      const rightIdentity = canonicalScopeIdentity(right.path)
      if (
        isSameOrInside(leftIdentity.foldedPath, rightIdentity.foldedPath) ||
        isSameOrInside(rightIdentity.foldedPath, leftIdentity.foldedPath) ||
        (leftIdentity.inode !== undefined && leftIdentity.inode === rightIdentity.inode)
      ) {
        throw new SourceScopeError(
          'OVERLAPPING_SOURCES',
          `Sources overlap: ${left.id} and ${right.id}`,
        )
      }
    }
  }

  return { plugins: normalizedPlugins, sources }
}

export function sourceContractFingerprint(source: ResolvedSource): string {
  const contract = {
    path: source.path,
    sensitivity: source.sensitivity,
    expectedType: source.expectedType,
    requirement: source.requirement,
    recoveryScope: source.recoveryScope,
    consistencyGroup: source.consistencyGroup ?? null,
    includeEmptyDirectories: source.includeEmptyDirectories,
  }
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex')
}

export function displayCaptureScope(plan: CapturePlan): string[] {
  return plan.sources.map(
    (source) =>
      `${source.id}\t${source.requirement}\t${source.sensitivity}\t${source.expectedType}\t${source.path}`,
  )
}

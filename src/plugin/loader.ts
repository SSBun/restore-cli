import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getBuiltinPlugin, getBuiltinPlugins } from './registry.js'
import { normalizePluginManifest, parseUserPlugin } from './schema.js'
import type { PluginManifest, ResolvedPluginManifest } from './types.js'

const MAX_PLUGIN_BYTES = 256 * 1024
const MAX_PLUGIN_FILES = 256

export interface PluginLoadOptions {
  onPluginReadStart?: (path: string) => void
}

export class PluginLoadError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PluginLoadError'
    this.code = code
  }
}

export function getUserPluginDirectory(home = process.env.HOME || homedir()): string {
  return resolve(home, '.config', 'restore', 'plugins')
}

function stableIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function readPluginFile(
  path: string,
  options: PluginLoadOptions,
  assertDirectoryStable: () => void,
): Buffer {
  assertDirectoryStable()
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw new PluginLoadError('UNSAFE_PLUGIN_FILE', 'User plugin must be a regular no-follow file')
  }

  try {
    const metadata = fstatSync(descriptor, { bigint: true })
    if (!metadata.isFile() || metadata.size > BigInt(MAX_PLUGIN_BYTES)) {
      throw new PluginLoadError('UNSAFE_PLUGIN_FILE', 'User plugin must be a bounded regular file')
    }
    const size = Number(metadata.size)
    options.onPluginReadStart?.(path)
    assertDirectoryStable()
    const content = Buffer.allocUnsafe(size + 1)
    let offset = 0
    while (offset < content.length) {
      const length = readSync(descriptor, content, offset, content.length - offset, null)
      if (length === 0) break
      offset += length
    }
    if (offset !== size || offset > MAX_PLUGIN_BYTES) {
      throw new PluginLoadError('UNSAFE_PLUGIN_FILE', 'User plugin changed while being read')
    }
    const after = fstatSync(descriptor, { bigint: true })
    let pathAfter: BigIntStats
    try {
      pathAfter = lstatSync(path, { bigint: true })
    } catch {
      throw new PluginLoadError('UNSAFE_PLUGIN_FILE', 'User plugin changed while being read')
    }
    assertDirectoryStable()
    if (
      !pathAfter.isFile() ||
      !stableIdentity(metadata, after) ||
      !stableIdentity(after, pathAfter)
    ) {
      throw new PluginLoadError('UNSAFE_PLUGIN_FILE', 'User plugin changed while being read')
    }
    return content.subarray(0, offset)
  } finally {
    closeSync(descriptor)
  }
}

export function loadUserPlugins(
  pluginDirectory = getUserPluginDirectory(),
  options: PluginLoadOptions = {},
): ResolvedPluginManifest[] {
  let directoryDescriptor: number
  try {
    directoryDescriptor = openSync(
      pluginDirectory,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new PluginLoadError('UNSAFE_PLUGIN_DIRECTORY', 'User plugin directory is unreadable')
  }
  try {
    const before = fstatSync(directoryDescriptor, { bigint: true })
    const assertDirectoryStable = (): void => {
      let held: BigIntStats
      let current: BigIntStats
      try {
        held = fstatSync(directoryDescriptor, { bigint: true })
        current = lstatSync(pluginDirectory, { bigint: true })
      } catch {
        throw new PluginLoadError(
          'UNSAFE_PLUGIN_DIRECTORY',
          'User plugin directory changed while being read',
        )
      }
      if (
        !held.isDirectory() ||
        !current.isDirectory() ||
        held.dev !== before.dev ||
        held.ino !== before.ino ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      ) {
        throw new PluginLoadError(
          'UNSAFE_PLUGIN_DIRECTORY',
          'User plugin directory changed while being read',
        )
      }
    }
    assertDirectoryStable()

    let names: string[]
    try {
      names = readdirSync(pluginDirectory)
        .filter((name) => name.endsWith('.json'))
        .sort()
      assertDirectoryStable()
    } catch (error) {
      if (error instanceof PluginLoadError) throw error
      throw new PluginLoadError('UNSAFE_PLUGIN_DIRECTORY', 'User plugin directory is unreadable')
    }
    if (names.length > MAX_PLUGIN_FILES) {
      throw new PluginLoadError('TOO_MANY_PLUGIN_FILES', 'User plugin directory has too many files')
    }

    const plugins: ResolvedPluginManifest[] = []
    const pluginNames = new Set(getBuiltinPlugins().map((plugin) => plugin.name))
    for (const name of names) {
      let plugin: ResolvedPluginManifest
      let content: Buffer | undefined
      try {
        content = readPluginFile(join(pluginDirectory, name), options, assertDirectoryStable)
        plugin = parseUserPlugin(JSON.parse(content.toString('utf8')))
      } catch (error) {
        if (error instanceof PluginLoadError) throw error
        throw new PluginLoadError('INVALID_PLUGIN', `User plugin ${name} is invalid`)
      } finally {
        content?.fill(0)
      }
      if (pluginNames.has(plugin.name)) {
        throw new PluginLoadError('DUPLICATE_PLUGIN', `Plugin name is duplicated: ${plugin.name}`)
      }
      pluginNames.add(plugin.name)
      plugins.push(plugin)
    }

    assertDirectoryStable()
    return plugins
  } finally {
    closeSync(directoryDescriptor)
  }
}

export function getEnabledPlugins(
  pluginNames: string[],
  pluginDirectory?: string,
): ResolvedPluginManifest[] {
  const users = loadUserPlugins(pluginDirectory)
  const byName = new Map<string, PluginManifest>([
    ...getBuiltinPlugins().map((plugin) => [plugin.name, plugin] as const),
    ...users.map((plugin) => [plugin.name, plugin] as const),
  ])
  return pluginNames
    .map((name) => byName.get(name))
    .filter((plugin): plugin is PluginManifest => plugin !== undefined)
    .map(normalizePluginManifest)
}

export function getAllPlugins(pluginDirectory?: string): ResolvedPluginManifest[] {
  return [...getBuiltinPlugins().map(normalizePluginManifest), ...loadUserPlugins(pluginDirectory)]
}

export function getPlugin(
  name: string,
  pluginDirectory?: string,
): ResolvedPluginManifest | undefined {
  const builtin = getBuiltinPlugin(name)
  if (builtin) return normalizePluginManifest(builtin)
  return loadUserPlugins(pluginDirectory).find((plugin) => plugin.name === name)
}

import { z } from 'zod'
import type { PluginManifest, ResolvedPluginManifest, SourceSpec } from './types.js'

const SourceSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    path: z.string().min(1).max(4096),
    requirement: z.enum(['required', 'optional']),
    sensitivity: z.enum(['public', 'private', 'secret']).default('secret'),
    expectedType: z.enum(['file', 'directory', 'symlink', 'any']),
    recoveryScope: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    consistencyGroup: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .optional(),
    includeEmptyDirectories: z.boolean().optional(),
  })
  .strict()

const CommonPluginSchema = {
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  description: z.string().min(1).max(1000),
}

const DeclarativePluginSchema = z
  .object({
    ...CommonPluginSchema,
    sources: z.array(SourceSchema).min(1).max(256),
  })
  .strict()

const LegacyPluginSchema = z
  .object({
    ...CommonPluginSchema,
    paths: z.array(z.string().min(1).max(4096)).min(1).max(256),
  })
  .strict()

export const UserPluginSchema = z.union([DeclarativePluginSchema, LegacyPluginSchema])

export function legacySource(path: string, index: number): SourceSpec {
  return {
    name: `path-${index + 1}`,
    path,
    requirement: 'optional',
    sensitivity: 'private',
    expectedType: 'any',
    recoveryScope: 'exact',
    includeEmptyDirectories: false,
  }
}

export function normalizePluginManifest(plugin: PluginManifest): ResolvedPluginManifest {
  const sources = plugin.sources ?? plugin.paths.map(legacySource)
  return {
    ...plugin,
    paths: sources.map((source) => source.path),
    sources,
  }
}

export function parseUserPlugin(value: unknown): ResolvedPluginManifest {
  const parsed = UserPluginSchema.parse(value)
  if ('sources' in parsed) {
    const names = new Set<string>()
    for (const source of parsed.sources) {
      if (names.has(source.name)) throw new Error(`Duplicate source name: ${source.name}`)
      names.add(source.name)
    }
    return {
      ...parsed,
      paths: parsed.sources.map((source) => source.path),
      sources: parsed.sources,
    }
  }
  return {
    ...parsed,
    sources: parsed.paths.map(legacySource),
  }
}

import type { ResolvedPluginManifest } from '../plugin/types.js'
import type { ExpectedEntryType, SourceRequirement, SourceSensitivity } from '../plugin/types.js'

export interface ResolvedSource {
  id: string
  plugin: string
  name: string
  declaredPath: string
  path: string
  requirement: SourceRequirement
  sensitivity: SourceSensitivity
  expectedType: ExpectedEntryType
  recoveryScope: string
  consistencyGroup?: string
  includeEmptyDirectories: boolean
  exclude: string[]
}

export interface CapturePlan {
  plugins: ResolvedPluginManifest[]
  sources: ResolvedSource[]
}

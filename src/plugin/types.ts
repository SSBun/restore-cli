export type PluginPrepareHook =
  | 'mac-apps-inventory'
  | 'homebrew-brewfile'
  | 'raycast-extensions'
  | 'vscode-extensions-list'

export type SourceRequirement = 'required' | 'optional'
export type SourceSensitivity = 'public' | 'private' | 'secret'
export type ExpectedEntryType = 'file' | 'directory' | 'symlink' | 'any'

export interface SourceSpec {
  name: string
  path: string
  requirement: SourceRequirement
  sensitivity: SourceSensitivity
  expectedType: ExpectedEntryType
  recoveryScope: string
  consistencyGroup?: string
  includeEmptyDirectories?: boolean
  exclude?: string[]
}

export interface PluginManifest {
  name: string
  description: string
  /** Normalized declarative sources. Legacy callers may still provide only `paths`. */
  sources?: SourceSpec[]
  /** Compatibility view used by the 0.1.x reader and built-in prepare hooks. */
  paths: string[]
  prepare?: PluginPrepareHook
}

export interface ResolvedPluginManifest extends PluginManifest {
  sources: SourceSpec[]
}

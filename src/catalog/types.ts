import type {
  ExpectedEntryType,
  ResolvedPluginManifest,
  SourceRequirement,
  SourceSensitivity,
} from '../plugin/types.js'
import type { MetadataFidelityIssue } from './stable-read.js'

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
}

export interface CapturePlan {
  plugins: ResolvedPluginManifest[]
  sources: ResolvedSource[]
}

export interface CapturedXattr {
  name: string
  value: string
}

export interface CapturedMetadata {
  mode: number
  size: number
  modifiedAtNs: string
  createdAtNs?: string
  xattrs?: CapturedXattr[]
  flags?: string[]
}

export type CapturedEntryType = 'file' | 'directory' | 'symlink'

export interface CapturedEntry {
  id: string
  sourceId: string
  relativePath: string
  type: CapturedEntryType
  metadata: CapturedMetadata
  fidelityIssues?: MetadataFidelityIssue[]
  linkTarget?: string
  hardlinkTo?: string
  contentHash?: string
  content?: Buffer
  /** Capture-only identity; omitted from the protected manifest. */
  identity?: {
    device: string
    inode: string
    changedAtNs: string
    hardlinkCount: string
  }
}

export interface CatalogIssue {
  code: string
  sourceId: string
  message: string
  severity: 'warning' | 'partial' | 'failure'
}

export interface CapturedSource {
  source: ResolvedSource
  status: 'captured' | 'missing' | 'failed' | 'unstable'
  entryIds: string[]
  issues: CatalogIssue[]
}

export interface CaptureResult {
  sources: CapturedSource[]
  entries: CapturedEntry[]
  issues: CatalogIssue[]
  requiredFailed: boolean
  consistencyGroupsFailed: string[]
}

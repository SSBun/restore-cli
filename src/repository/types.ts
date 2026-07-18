import type { ContentProtector } from '../protection/crypto.js'

export const REPOSITORY_FORMAT_VERSION = 1 as const
export const REPOSITORY_DIRECTORY_NAME = 'RestoreBackup'

export type ProtectionMode = 'encrypted' | 'plaintext'
export type RepositoryIntent = 'read' | 'write'

export interface TargetIdentity {
  deviceId: string
  fileSystemType: string
  mountPath: string
  stableIdentity: string
}

export interface RepositoryDescriptor {
  formatVersion: typeof REPOSITORY_FORMAT_VERSION
  repositoryId: string
  createdAt: string
  protection: ProtectionMode
  targetIdentity: TargetIdentity
}

export interface TargetCapabilities {
  readable: true
  writeChecked: boolean
  writable: boolean
  readback: boolean
  atomicRename: boolean
}

export interface TargetPreflight {
  path: string
  identity: TargetIdentity
  capabilities: TargetCapabilities
  availableBytes: bigint
}

export interface RepositoryLayout {
  root: string
  descriptor: string
  keys: string
  recoveryKey: string
  keyCheck: string
  points: string
  locks: string
  repositoryLock: string
  operations: string
}

export interface RepositoryHandle {
  path: string
  descriptor: RepositoryDescriptor
  layout: RepositoryLayout
  preflight: TargetPreflight
  intent: RepositoryIntent
  protector?: ContentProtector
  close(): void
}

export interface RepositoryInitResult {
  repositoryPath: string
  repositoryId: string
  createdAt: string
  protection: ProtectionMode
  targetIdentity: TargetIdentity
  availableBytes: string
  recoveryCredentialExported: boolean
}

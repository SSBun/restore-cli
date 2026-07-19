import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { authenticateStaging } from '../recovery/index.js'
import {
  assertSafeAbsoluteDirectoryChain,
  atomicPublish,
  atomicRenameDirectory,
  deleteEntrySafely,
  lstatIdentity,
  mkdirUnderRoot,
  pathsOverlap,
} from '../recovery/safe-io.js'
import type { PathIdentity } from '../recovery/safe-io.js'
import {
  readBoundedRegularFile,
  syncDirectory,
  writeDurableExclusiveFile,
} from '../repository/io.js'
import {
  HOMEBREW_EXECUTABLE,
  VSCODE_EXECUTABLE_CANDIDATES,
  collectCurrentMachineInventory,
} from './current.js'
import { synthesizeBrewfile } from './inventory.js'
import {
  assertSupportedRecoverySystem,
  generateRecoveryPlan,
  loadAuthenticatedExpectedInventory,
  recoveryPlanApprovalSnapshot,
} from './plan.js'
import type {
  CurrentMachineInventory,
  ExecuteRecoveryInstallOptions,
  ExpectedInventory,
  InstallJournalItem,
  InstallPhase,
  InstallerAction,
  RecoveryInstallResult,
  RecoveryPlan,
  RecoveryPlanApprovalSnapshot,
} from './types.js'
import { RecoveryPlanError } from './types.js'

const execFileAsync = promisify(execFile)
export const MAX_INSTALL_JOURNAL_BYTES = 4 * 1024 * 1024
export const MAX_INSTALL_JOURNAL_ITEMS = 10_000
const DEAD_PARENT_OWNER_PUBLISH_GRACE_MS = 5 * 60_000 + 15_000
const HASH_PATTERN = /^[0-9a-f]{64}$/
const PHASES = new Set<InstallPhase>(['homebrew', 'vscode'])
const ITEM_STATUSES = new Set([
  'pending',
  'succeeded',
  'already-present',
  'failed',
  'manual',
  'skipped',
])
const STALE_LEASE_RENAME_WORKER = String.raw`
const fs = require('node:fs')
const crypto = require('node:crypto')
const [fromName, toName, parentPath, parentDev, parentIno, sourceDev, sourceIno, ownerDev, ownerIno, ownerSize, ownerMtime, ownerCtime, ownerHash] = process.argv.slice(1)
let parent
let ownerFile
try {
  if (!/^\.recovery-install-[a-zA-Z0-9._-]+\.lock$/.test(fromName) || !/^\.stale-recovery-install-[0-9a-f-]+$/.test(toName)) throw new Error('name')
  parent = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const held = fs.fstatSync(parent, { bigint: true })
  const namedParent = fs.lstatSync(parentPath, { bigint: true })
  if (!held.isDirectory() || held.dev !== BigInt(parentDev) || held.ino !== BigInt(parentIno) || namedParent.dev !== held.dev || namedParent.ino !== held.ino) throw new Error('parent')
  const source = fs.lstatSync(fromName, { bigint: true })
  if (!source.isDirectory() || source.isSymbolicLink() || source.dev !== BigInt(sourceDev) || source.ino !== BigInt(sourceIno)) throw new Error('source')
  const children = fs.readdirSync(fromName)
  if (children.length !== 1 || children[0] !== 'owner.json') throw new Error('children')
  const owner = fs.lstatSync(fromName + '/owner.json', { bigint: true })
  if (!owner.isFile() || owner.isSymbolicLink() || owner.dev !== BigInt(ownerDev) || owner.ino !== BigInt(ownerIno) || owner.size !== BigInt(ownerSize) || owner.mtimeNs !== BigInt(ownerMtime) || owner.ctimeNs !== BigInt(ownerCtime)) throw new Error('owner')
  ownerFile = fs.openSync(fromName + '/owner.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  const heldOwner = fs.fstatSync(ownerFile, { bigint: true })
  const ownerPayload = fs.readFileSync(ownerFile)
  const heldAfter = fs.fstatSync(ownerFile, { bigint: true })
  if (heldOwner.dev !== owner.dev || heldOwner.ino !== owner.ino || heldOwner.size !== owner.size || heldOwner.mtimeNs !== owner.mtimeNs || heldOwner.ctimeNs !== owner.ctimeNs || heldAfter.dev !== owner.dev || heldAfter.ino !== owner.ino || heldAfter.size !== owner.size || heldAfter.mtimeNs !== owner.mtimeNs || heldAfter.ctimeNs !== owner.ctimeNs || crypto.createHash('sha256').update(ownerPayload).digest('hex') !== ownerHash) throw new Error('owner content')
  ownerPayload.fill(0)
  fs.renameSync(fromName, toName)
  fs.fsyncSync(parent)
  const final = fs.lstatSync(toName, { bigint: true })
  if (final.dev !== source.dev || final.ino !== source.ino) throw new Error('final')
  const finalOwner = fs.lstatSync(toName + '/owner.json', { bigint: true })
  if (finalOwner.dev !== owner.dev || finalOwner.ino !== owner.ino || finalOwner.size !== owner.size || finalOwner.mtimeNs !== owner.mtimeNs || finalOwner.ctimeNs !== owner.ctimeNs) throw new Error('final owner')
  process.stdout.write(JSON.stringify({ ok: true }))
} catch { process.stdout.write(JSON.stringify({ ok: false })); process.exitCode = 1 }
finally { if (ownerFile !== undefined) try { fs.closeSync(ownerFile) } catch {}; if (parent !== undefined) try { fs.closeSync(parent) } catch {} }
`

export type InstallerCommandRunner = (
  executable: string,
  args: readonly string[],
  limits: { timeoutMs: number; maxOutputBytes: number },
  lifecycle?: InstallerCommandLifecycle,
) => Promise<{ exitCode: number }>

export interface InstallerCommandLifecycle {
  launchPending(startedAt: string): Promise<void>
  childStarted(pid: number, expiresAt: string): Promise<void>
  childStopped(): Promise<void>
}

export interface InstallerCommandTestHooks {
  kill?: (signal: NodeJS.Signals) => boolean
}

interface InstallJournal {
  formatVersion: 1
  kind: 'recovery-install-journal'
  planFingerprint: string
  repositoryId: string
  protection: 'encrypted' | 'plaintext'
  pointId: string
  manifestFingerprint: string
  stagingPath: string
  phases: InstallPhase[]
  approval: RecoveryPlanApprovalSnapshot
  items: InstallJournalItem[]
  createdAt: string
  updatedAt: string
}

export interface RecoveryInstallDependencies {
  generatePlan?: typeof generateRecoveryPlan
  commandRunner?: InstallerCommandRunner
  collectCurrentInventory?: () => Promise<CurrentMachineInventory>
  lockRoot?: string
  beforeStaleLeaseQuarantine?: () => Promise<void>
  beforeInstallLeasePublish?: (pendingPath: string, finalPath: string) => Promise<void>
  beforeInstallerChildPidPublish?: () => Promise<void>
}

interface InstallLease {
  path: string
  ownerPath: string
  owner: string
  device: bigint
  inode: bigint
  ownerIdentity: PathIdentity
  ownerPayload: string
  createdAt: string
  activeCommand: LeaseOwnerRecord['activeCommand']
}

interface LeaseOwnerRecord {
  owner: string
  pid: number
  createdAt: string
  activeCommand:
    | { state: 'launch-pending'; pid: number; startedAt: string }
    | { state: 'running'; pid: number; expiresAt: string }
    | null
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sameIdentity(left: PathIdentity | null, right: PathIdentity): boolean {
  return (
    left?.type === right.type &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs
  )
}

function leaseOwnerPayload(record: LeaseOwnerRecord): string {
  return `${JSON.stringify(record)}\n`
}

function parseLeaseOwner(payload: Buffer): LeaseOwnerRecord | null {
  try {
    const parsed: unknown = JSON.parse(payload.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const value = parsed as Record<string, unknown>
    if (
      !expectedKeys(value, ['owner', 'pid', 'createdAt', 'activeCommand']) ||
      typeof value.owner !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.owner) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return null
    }
    if (value.activeCommand !== null) {
      if (
        !value.activeCommand ||
        typeof value.activeCommand !== 'object' ||
        Array.isArray(value.activeCommand) ||
        typeof (value.activeCommand as Record<string, unknown>).state !== 'string'
      ) {
        return null
      }
      const active = value.activeCommand as Record<string, unknown>
      if (!Number.isSafeInteger(active.pid) || (active.pid as number) < 1) return null
      if (active.state === 'launch-pending') {
        if (
          !expectedKeys(active, ['state', 'pid', 'startedAt']) ||
          typeof active.startedAt !== 'string' ||
          !Number.isFinite(Date.parse(active.startedAt)) ||
          new Date(active.startedAt).toISOString() !== active.startedAt
        )
          return null
      } else if (active.state === 'running') {
        if (
          !expectedKeys(active, ['state', 'pid', 'expiresAt']) ||
          typeof active.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(active.expiresAt)) ||
          new Date(active.expiresAt).toISOString() !== active.expiresAt
        )
          return null
      } else {
        return null
      }
    }
    return value as unknown as LeaseOwnerRecord
  } catch {
    return null
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function isActionItem(
  item: InstallJournalItem,
): item is Extract<InstallJournalItem, { phase: InstallPhase }> {
  return item.phase === 'homebrew' || item.phase === 'vscode'
}

function manualJournalItems(
  approval: Pick<RecoveryPlanApprovalSnapshot, 'manualDependencies' | 'software'>,
): Extract<InstallJournalItem, { phase: 'manual' }>[] {
  const dependencies = approval.manualDependencies.map((dependency) => ({
    id: `manual-dependency:${dependency.id}`,
    phase: 'manual' as const,
    kind: dependency.kind,
    name: dependency.name,
    reason: dependency.reason,
    status: 'manual' as const,
  }))
  const software = approval.software
    .filter((item) => item.status === 'missing' && item.recovery === 'manual')
    .map((item) => ({
      id: `manual-software:${item.id}`,
      phase: 'manual' as const,
      kind: item.kind,
      name: item.name,
      reason: item.reason ?? 'This missing software requires manual recovery',
      status: 'manual' as const,
    }))
  const items = [...dependencies, ...software].sort((left, right) => compare(left.id, right.id))
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new RecoveryPlanError(
      'integrity',
      'INSTALL_JOURNAL_DUPLICATE_ITEM',
      'The reviewed plan contains duplicate manual recovery items',
    )
  }
  return items
}

function serializeJournal(journal: InstallJournal): string {
  if (journal.items.length > MAX_INSTALL_JOURNAL_ITEMS) {
    throw new RecoveryPlanError(
      'configuration',
      'INSTALL_JOURNAL_ITEM_LIMIT_EXCEEDED',
      'The reviewed recovery plan exceeds the supported install journal item limit',
    )
  }
  const payload = `${JSON.stringify(journal)}\n`
  if (Buffer.byteLength(payload) > MAX_INSTALL_JOURNAL_BYTES) {
    throw new RecoveryPlanError(
      'configuration',
      'INSTALL_JOURNAL_BYTE_LIMIT_EXCEEDED',
      'The reviewed recovery plan exceeds the supported install journal byte limit',
    )
  }
  return payload
}

function safeNow(now?: () => Date): Date {
  const value = now?.() ?? new Date()
  if (!Number.isFinite(value.getTime())) throw new Error('Invalid clock')
  return value
}

function normalizePhases(phases: InstallPhase[]): InstallPhase[] {
  const result = [...new Set(phases)].sort(compare)
  if (result.length === 0 || result.some((phase) => !PHASES.has(phase))) {
    throw new RecoveryPlanError(
      'configuration',
      'INSTALL_PHASE_REQUIRED',
      'At least one supported install phase must be selected explicitly',
    )
  }
  return result
}

export async function runInstallerCommand(
  executable: string,
  args: readonly string[],
  limits: { timeoutMs: number; maxOutputBytes: number },
  lifecycle?: InstallerCommandLifecycle,
  testHooks: InstallerCommandTestHooks = {},
): Promise<{ exitCode: number }> {
  const child = spawn(executable, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let outputBytes = 0
  let timedOut = false
  let overflowed = false
  let spawnError: NodeJS.ErrnoException | undefined
  let terminationStarted = false
  let forceKillTimer: NodeJS.Timeout | undefined
  let abandonTimer: NodeJS.Timeout | undefined
  let abandon: (() => void) | undefined
  const abandoned = new Promise<void>((resolveAbandoned) => {
    abandon = resolveAbandoned
  })
  const terminate = (): void => {
    if (terminationStarted) return
    terminationStarted = true
    const kill = testHooks.kill ?? ((signal: NodeJS.Signals) => child.kill(signal))
    kill('SIGTERM')
    forceKillTimer = setTimeout(() => kill('SIGKILL'), 2_000)
    forceKillTimer.unref()
    abandonTimer = setTimeout(() => abandon?.(), 5_000)
    abandonTimer.unref()
  }
  const count = (chunk: Buffer): void => {
    outputBytes += chunk.length
    if (outputBytes > limits.maxOutputBytes && !overflowed) {
      overflowed = true
      terminate()
    }
  }
  child.stdout.on('data', count)
  child.stderr.on('data', count)
  child.once('error', (error) => {
    spawnError = error
  })
  const closed = new Promise<number | null>((resolveClose) => child.once('close', resolveClose))
  const expiresAt = new Date(Date.now() + limits.timeoutMs + 10_000).toISOString()
  try {
    if (child.pid) await lifecycle?.childStarted(child.pid, expiresAt)
  } catch (error) {
    terminate()
    const publicationFailureOutcome = await Promise.race([
      closed.then(() => 'closed' as const),
      abandoned.then(() => 'abandoned' as const),
    ])
    if (forceKillTimer) clearTimeout(forceKillTimer)
    if (abandonTimer) clearTimeout(abandonTimer)
    if (publicationFailureOutcome === 'abandoned') {
      throw new RecoveryPlanError(
        'internal',
        'INSTALLER_CHILD_UNREAPED',
        'Installer child survived a failed durable child-PID lease publication',
      )
    }
    if (
      error instanceof RecoveryPlanError &&
      error.code === 'INSTALLER_CHILD_PID_PUBLICATION_FAILED'
    )
      throw error
    throw new RecoveryPlanError(
      'lock',
      'INSTALLER_CHILD_PID_PUBLICATION_FAILED',
      'Installer child PID could not be published durably to the recovery lease',
    )
  }
  const timer = setTimeout(() => {
    timedOut = true
    terminate()
  }, limits.timeoutMs)
  timer.unref()
  const outcome = await Promise.race([
    closed.then((exitCode) => ({ closed: true as const, exitCode })),
    abandoned.then(() => ({ closed: false as const, exitCode: null })),
  ])
  clearTimeout(timer)
  if (forceKillTimer) clearTimeout(forceKillTimer)
  if (abandonTimer) clearTimeout(abandonTimer)
  if (!outcome.closed) {
    throw new RecoveryPlanError(
      'internal',
      'INSTALLER_CHILD_UNREAPED',
      'An allowlisted installer child did not terminate within the bounded shutdown window',
    )
  }
  await lifecycle?.childStopped()
  if (spawnError?.code === 'ENOENT') {
    throw new RecoveryPlanError(
      'unsupported',
      'INSTALLER_BINARY_MISSING',
      'A fixed allowlisted installer executable is not available',
    )
  }
  if (timedOut || overflowed || spawnError) {
    throw new RecoveryPlanError(
      'internal',
      timedOut
        ? 'INSTALLER_TIMEOUT'
        : overflowed
          ? 'INSTALLER_OUTPUT_LIMIT_EXCEEDED'
          : 'INSTALLER_COMMAND_FAILED',
      'An allowlisted installer command failed within its bounded execution environment',
    )
  }
  return { exitCode: outcome.exitCode ?? 1 }
}

function journalName(planFingerprint: string, phases: InstallPhase[]): string {
  return `recovery-install-${planFingerprint}-${hash(phases.join('\0')).slice(0, 16)}.json`
}

function expectedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  )
}

function parseJournalUnchecked(payload: Buffer): InstallJournal {
  const parsed: unknown = JSON.parse(payload.toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RecoveryPlanError(
      'integrity',
      'INSTALL_JOURNAL_INVALID',
      'Install journal is invalid',
    )
  }
  const value = parsed as Record<string, unknown>
  if (
    !expectedKeys(value, [
      'formatVersion',
      'kind',
      'planFingerprint',
      'repositoryId',
      'protection',
      'pointId',
      'manifestFingerprint',
      'stagingPath',
      'phases',
      'approval',
      'items',
      'createdAt',
      'updatedAt',
    ]) ||
    value.formatVersion !== 1 ||
    value.kind !== 'recovery-install-journal' ||
    typeof value.planFingerprint !== 'string' ||
    !HASH_PATTERN.test(value.planFingerprint) ||
    typeof value.repositoryId !== 'string' ||
    (value.protection !== 'encrypted' && value.protection !== 'plaintext') ||
    typeof value.pointId !== 'string' ||
    typeof value.manifestFingerprint !== 'string' ||
    !HASH_PATTERN.test(value.manifestFingerprint) ||
    typeof value.stagingPath !== 'string' ||
    !Array.isArray(value.phases) ||
    value.phases.some((phase) => typeof phase !== 'string' || !PHASES.has(phase as InstallPhase)) ||
    JSON.stringify(value.phases) !==
      JSON.stringify(normalizePhases(value.phases as InstallPhase[])) ||
    !value.approval ||
    typeof value.approval !== 'object' ||
    Array.isArray(value.approval) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_INSTALL_JOURNAL_ITEMS ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    new Date(value.updatedAt).toISOString() !== value.updatedAt ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) {
    throw new RecoveryPlanError(
      'integrity',
      'INSTALL_JOURNAL_INVALID',
      'Install journal is invalid',
    )
  }
  const items = value.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new RecoveryPlanError(
        'integrity',
        'INSTALL_JOURNAL_INVALID',
        'Install journal is invalid',
      )
    }
    const entry = item as Record<string, unknown>
    if (entry.phase === 'manual') {
      if (
        !expectedKeys(entry, ['id', 'phase', 'kind', 'name', 'reason', 'status']) ||
        typeof entry.id !== 'string' ||
        !entry.id.startsWith('manual-') ||
        typeof entry.kind !== 'string' ||
        typeof entry.name !== 'string' ||
        typeof entry.reason !== 'string' ||
        entry.status !== 'manual'
      ) {
        throw new RecoveryPlanError(
          'integrity',
          'INSTALL_JOURNAL_INVALID',
          'Install journal is invalid',
        )
      }
      return entry as unknown as InstallJournalItem
    }
    const allowed =
      entry.issueCode === undefined
        ? ['id', 'phase', 'kind', 'value', 'status']
        : ['id', 'phase', 'kind', 'value', 'status', 'issueCode']
    if (
      !expectedKeys(entry, allowed) ||
      typeof entry.id !== 'string' ||
      typeof entry.phase !== 'string' ||
      !PHASES.has(entry.phase as InstallPhase) ||
      (entry.kind !== 'homebrew-tap' &&
        entry.kind !== 'homebrew-formula' &&
        entry.kind !== 'homebrew-cask' &&
        entry.kind !== 'vscode-extension') ||
      typeof entry.value !== 'string' ||
      entry.id !== `${entry.kind}:${entry.value}` ||
      !ITEM_STATUSES.has(entry.status as string) ||
      entry.status === 'manual' ||
      (entry.issueCode !== undefined && typeof entry.issueCode !== 'string')
    ) {
      throw new RecoveryPlanError(
        'integrity',
        'INSTALL_JOURNAL_INVALID',
        'Install journal is invalid',
      )
    }
    return entry as unknown as InstallJournalItem
  })
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new RecoveryPlanError(
      'integrity',
      'INSTALL_JOURNAL_INVALID',
      'Install journal contains duplicate actions',
    )
  }
  const approval = value.approval as Record<string, unknown>
  if (
    !expectedKeys(approval, [
      'formatVersion',
      'repositoryId',
      'protection',
      'pointId',
      'manifestFingerprint',
      'selectionFingerprint',
      'stagingVerified',
      'stagingIssues',
      'configuration',
      'software',
      'allowlistedActions',
      'manualDependencies',
      'phases',
    ]) ||
    approval.formatVersion !== 1 ||
    approval.repositoryId !== value.repositoryId ||
    approval.protection !== value.protection ||
    approval.pointId !== value.pointId ||
    approval.manifestFingerprint !== value.manifestFingerprint ||
    typeof approval.stagingVerified !== 'boolean' ||
    !Array.isArray(approval.stagingIssues) ||
    !Array.isArray(approval.allowlistedActions) ||
    !Array.isArray(approval.configuration) ||
    !Array.isArray(approval.software) ||
    !Array.isArray(approval.manualDependencies) ||
    !Array.isArray(approval.phases) ||
    hash(JSON.stringify(approval)) !== value.planFingerprint
  ) {
    throw new RecoveryPlanError(
      'integrity',
      'INSTALL_JOURNAL_APPROVAL_INVALID',
      'Install journal no longer matches the exact reviewed plan',
    )
  }
  const approvedActions = approval.allowlistedActions
  const actionItems = items.filter(isActionItem)
  const manualItems = items.filter((item) => item.phase === 'manual')
  if (
    JSON.stringify(
      actionItems.map(({ status: _status, issueCode: _issueCode, ...action }) => action),
    ) !== JSON.stringify(approvedActions) ||
    JSON.stringify(manualItems) !==
      JSON.stringify(manualJournalItems(approval as unknown as RecoveryPlanApprovalSnapshot))
  ) {
    throw new RecoveryPlanError(
      'integrity',
      'INSTALL_JOURNAL_ACTION_SET_MISMATCH',
      'Install journal action set differs from the exact reviewed plan',
    )
  }
  return {
    ...(value as unknown as InstallJournal),
    approval: approval as unknown as RecoveryPlanApprovalSnapshot,
    items,
  }
}

function parseJournal(payload: Buffer): InstallJournal {
  try {
    return parseJournalUnchecked(payload)
  } catch (error) {
    if (error instanceof RecoveryPlanError && error.category === 'integrity') throw error
    throw new RecoveryPlanError(
      'integrity',
      'INSTALL_JOURNAL_INVALID',
      'Install journal is invalid',
    )
  }
}

async function writeJournal(path: string, journal: InstallJournal): Promise<void> {
  const payload = serializeJournal(journal)
  const existing = await lstatIdentity(path)
  await atomicPublish({
    kind: 'file',
    destination: path,
    expected: existing,
    payload,
  })
}

async function readJournal(path: string): Promise<InstallJournal | null> {
  let payload: Buffer | undefined
  try {
    const identity = await lstatIdentity(path)
    if (!identity) return null
    if (identity.type !== 'file') {
      throw new RecoveryPlanError(
        'integrity',
        'INSTALL_JOURNAL_INVALID',
        'Install journal is not a regular file',
      )
    }
    payload = await readBoundedRegularFile(path, MAX_INSTALL_JOURNAL_BYTES)
    return parseJournal(payload)
  } catch (error) {
    if (error instanceof RecoveryPlanError && error.category === 'integrity') throw error
    throw new RecoveryPlanError(
      'integrity',
      'INSTALL_JOURNAL_INVALID',
      'Install journal is missing, oversized, malformed, or unsafe',
    )
  } finally {
    payload?.fill(0)
  }
}

function allExpectedActions(expected: ExpectedInventory): Set<string> {
  return new Set([
    ...expected.homebrew.taps.map((value) => `homebrew-tap:${value}`),
    ...expected.homebrew.formulae.map((value) => `homebrew-formula:${value}`),
    ...expected.homebrew.casks.map((value) => `homebrew-cask:${value}`),
    ...expected.vscodeExtensions.map((value) => `vscode-extension:${value}`),
  ])
}

async function validateJournalBinding(
  options: ExecuteRecoveryInstallOptions,
  journal: InstallJournal,
  planFingerprint: string,
  phases: InstallPhase[],
): Promise<void> {
  if (
    journal.planFingerprint !== planFingerprint ||
    journal.repositoryId !== options.expectedRepositoryId ||
    journal.protection !== options.expectedProtection ||
    JSON.stringify(journal.phases) !== JSON.stringify(phases)
  ) {
    throw new RecoveryPlanError(
      'integrity',
      'INSTALL_JOURNAL_BINDING_MISMATCH',
      'Install journal does not match the approved repository plan and phases',
    )
  }
  const authenticated = await authenticateStaging(
    {
      repositoryPath: options.repositoryPath,
      expectedRepositoryId: options.expectedRepositoryId,
      expectedProtection: options.expectedProtection,
      ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
    },
    journal.stagingPath,
  )
  if (authenticated.issues.length > 0) {
    const first = authenticated.issues[0]
    throw new RecoveryPlanError(
      first?.category ?? 'integrity',
      first?.code ?? 'INSTALL_STAGING_VERIFICATION_INCOMPLETE',
      'Install resume staging did not verify without fidelity issues',
    )
  }
  if (
    authenticated.manifest.health !== 'healthy' ||
    authenticated.descriptor.pointId !== journal.pointId ||
    authenticated.descriptor.manifestFingerprint !== journal.manifestFingerprint
  ) {
    throw new RecoveryPlanError(
      'integrity',
      'INSTALL_JOURNAL_BINDING_MISMATCH',
      'Install journal recovery-point binding no longer authenticates',
    )
  }
  const expected = await loadAuthenticatedExpectedInventory(
    journal.stagingPath,
    authenticated.descriptor,
    authenticated.manifest,
  )
  const allowlist = allExpectedActions(expected)
  if (
    journal.items
      .filter(isActionItem)
      .some(
        (item) =>
          !allowlist.has(item.id) ||
          (item.phase === 'homebrew' && item.kind === 'vscode-extension') ||
          (item.phase === 'vscode' && item.kind !== 'vscode-extension'),
      )
  ) {
    throw new RecoveryPlanError(
      'integrity',
      'INSTALL_ACTION_NOT_AUTHENTICATED',
      'Install journal contains an action outside authenticated inventory mappings',
    )
  }
}

function createJournal(plan: RecoveryPlan, phases: InstallPhase[], now: Date): InstallJournal {
  const approval = recoveryPlanApprovalSnapshot(plan)
  const journal: InstallJournal = {
    formatVersion: 1,
    kind: 'recovery-install-journal',
    planFingerprint: plan.fingerprint,
    repositoryId: plan.repository.id,
    protection: plan.repository.protection,
    pointId: plan.recoveryPoint.id,
    manifestFingerprint: plan.recoveryPoint.manifestFingerprint,
    stagingPath: plan.staging.path,
    phases,
    approval,
    items: [
      ...plan.allowlistedActions.map((action) => ({
        ...action,
        status: phases.includes(action.phase) ? ('pending' as const) : ('skipped' as const),
      })),
      ...manualJournalItems(approval),
    ],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
  serializeJournal(journal)
  return journal
}

async function assertPrivateStateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) === '/' || resolve(path) === resolve(homedir())) {
    throw new RecoveryPlanError(
      'configuration',
      'PRIVATE_INSTALL_STATE_REQUIRED',
      'Install state must be an explicit non-root, non-home absolute directory',
    )
  }
  await assertSafeAbsoluteDirectoryChain(path)
  const stat = await lstat(path, { bigint: true })
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077n) !== 0n ||
    (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))
  ) {
    throw new RecoveryPlanError(
      'configuration',
      'PRIVATE_INSTALL_STATE_REQUIRED',
      'Install state directory must be owned by the current user and inaccessible to group/other',
    )
  }
}

async function resolveAuthoritativeLockRoot(injected?: string): Promise<string> {
  try {
    const requested = injected
      ? resolve(injected)
      : await mkdirUnderRoot(homedir(), '.config/restore/recovery-locks')
    await assertPrivateStateDirectory(requested)
    return await realpath(requested)
  } catch {
    throw new RecoveryPlanError(
      'lock',
      'PRIVATE_RECOVERY_LOCK_ROOT_REQUIRED',
      'The authoritative recovery lock root must be a current-user private directory',
    )
  }
}

async function acquireInstallLease(
  lockRoot: string,
  name: string,
  now: Date,
  beforeQuarantine?: () => Promise<void>,
  beforePublish?: (pendingPath: string, finalPath: string) => Promise<void>,
): Promise<InstallLease> {
  const path = join(lockRoot, `.${name}.lock`)
  const owner = randomUUID()
  const createdAt = now.toISOString()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await lstatIdentity(path))) break
    if (
      attempt > 0 ||
      !(await quarantineStaleInstallLease(lockRoot, path, now, beforeQuarantine))
    ) {
      throw new RecoveryPlanError(
        'lock',
        'RECOVERY_INSTALL_ALREADY_RUNNING',
        'Another process owns this recovery install plan lease',
      )
    }
  }
  if (await lstatIdentity(path)) {
    throw new RecoveryPlanError(
      'lock',
      'RECOVERY_INSTALL_ALREADY_RUNNING',
      'Another process owns this recovery install plan lease',
    )
  }
  const rootIdentity = await lstatIdentity(lockRoot)
  if (!rootIdentity || rootIdentity.type !== 'directory') {
    throw new RecoveryPlanError(
      'lock',
      'RECOVERY_INSTALL_LEASE_FAILED',
      'Recovery install lease root changed before acquisition',
    )
  }
  const pendingPath = await mkdirUnderRoot(lockRoot, `.pending-recovery-install-${randomUUID()}`)
  const pendingIdentity = await lstatIdentity(pendingPath)
  if (!pendingIdentity || pendingIdentity.type !== 'directory') {
    throw new RecoveryPlanError(
      'lock',
      'RECOVERY_INSTALL_LEASE_FAILED',
      'Recovery install pending lease could not be created safely',
    )
  }
  const pendingOwnerPath = join(pendingPath, 'owner.json')
  let pendingOwnerIdentity: PathIdentity | null = null
  const cleanupOwnPending = async (): Promise<void> => {
    const currentOwner = await lstatIdentity(pendingOwnerPath).catch(() => null)
    if (pendingOwnerIdentity && sameIdentity(currentOwner, pendingOwnerIdentity)) {
      await deleteEntrySafely(pendingOwnerPath, pendingOwnerIdentity).catch(() => undefined)
    }
    const currentPending = await lstatIdentity(pendingPath).catch(() => null)
    if (
      currentPending?.type === 'directory' &&
      currentPending.device === pendingIdentity.device &&
      currentPending.inode === pendingIdentity.inode
    ) {
      await deleteEntrySafely(pendingPath, pendingIdentity).catch(() => undefined)
    }
  }
  try {
    const ownerPayload = leaseOwnerPayload({
      owner,
      pid: process.pid,
      createdAt,
      activeCommand: null,
    })
    await writeDurableExclusiveFile(pendingOwnerPath, ownerPayload)
    pendingOwnerIdentity = await lstatIdentity(pendingOwnerPath)
    if (!pendingOwnerIdentity || pendingOwnerIdentity.type !== 'file') {
      throw new Error('pending lease owner identity missing')
    }
    await syncDirectory(pendingPath)
    await syncDirectory(lockRoot)
    await beforePublish?.(pendingPath, path)
    await atomicRenameDirectory(pendingPath, path, rootIdentity)
    const identity = await lstatIdentity(path)
    const ownerPath = join(path, 'owner.json')
    const ownerIdentity = await lstatIdentity(ownerPath)
    if (
      !identity ||
      identity.type !== 'directory' ||
      !ownerIdentity ||
      ownerIdentity.type !== 'file' ||
      identity.device !== pendingIdentity.device ||
      identity.inode !== pendingIdentity.inode ||
      !sameIdentity(ownerIdentity, pendingOwnerIdentity)
    )
      throw new Error('lease identity missing')
    return {
      path,
      ownerPath,
      owner,
      device: identity.device,
      inode: identity.inode,
      ownerIdentity,
      ownerPayload,
      createdAt,
      activeCommand: null,
    }
  } catch (error) {
    await cleanupOwnPending()
    if (await lstatIdentity(path)) {
      throw new RecoveryPlanError(
        'lock',
        'RECOVERY_INSTALL_ALREADY_RUNNING',
        'Another process owns this recovery install plan lease',
      )
    }
    if (error instanceof RecoveryPlanError) throw error
    throw new RecoveryPlanError(
      'lock',
      'RECOVERY_INSTALL_LEASE_FAILED',
      'Recovery install lease could not be published safely',
    )
  }
}

async function quarantineStaleInstallLease(
  lockRoot: string,
  path: string,
  now: Date,
  beforeQuarantine?: () => Promise<void>,
): Promise<boolean> {
  const directoryIdentity = await lstatIdentity(path).catch(() => null)
  if (!directoryIdentity || directoryIdentity.type !== 'directory') return false
  const children = await readdir(path).catch(() => [])
  if (children.length !== 1 || children[0] !== 'owner.json') return false
  const ownerPath = join(path, 'owner.json')
  const ownerIdentity = await lstatIdentity(ownerPath).catch(() => null)
  if (!ownerIdentity || ownerIdentity.type !== 'file') return false
  const payload = await readBoundedRegularFile(ownerPath, 4096).catch(() => null)
  if (!payload) return false
  const ownerAfterRead = await lstatIdentity(ownerPath).catch(() => null)
  if (!sameIdentity(ownerAfterRead, ownerIdentity)) {
    payload.fill(0)
    return false
  }
  let record: LeaseOwnerRecord | null
  try {
    record = parseLeaseOwner(payload)
  } finally {
    // Retain the authenticated bytes until the rename worker has checked the digest.
  }
  if (!record || processIsAlive(record.pid)) {
    payload.fill(0)
    return false
  }
  if (
    !record.activeCommand &&
    now.getTime() < Date.parse(record.createdAt) + DEAD_PARENT_OWNER_PUBLISH_GRACE_MS
  ) {
    payload.fill(0)
    return false
  }
  // A dead owner may have crashed in the gap between durable launch intent and spawn.
  // Automatic recovery cannot prove that no child exists, so this remains a manual wedge.
  if (record.activeCommand?.state === 'launch-pending') {
    payload.fill(0)
    return false
  }
  if (
    record.activeCommand?.state === 'running' &&
    (now.getTime() < Date.parse(record.activeCommand.expiresAt) ||
      processIsAlive(record.activeCommand.pid))
  ) {
    payload.fill(0)
    return false
  }
  const parentIdentity = await lstatIdentity(lockRoot)
  if (!parentIdentity || parentIdentity.type !== 'directory') return false
  const quarantineName = `.stale-recovery-install-${randomUUID()}`
  const quarantinePath = join(lockRoot, quarantineName)
  try {
    await beforeQuarantine?.()
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '-e',
        STALE_LEASE_RENAME_WORKER,
        basename(path),
        quarantineName,
        lockRoot,
        parentIdentity.device.toString(),
        parentIdentity.inode.toString(),
        directoryIdentity.device.toString(),
        directoryIdentity.inode.toString(),
        ownerIdentity.device.toString(),
        ownerIdentity.inode.toString(),
        ownerIdentity.size.toString(),
        ownerIdentity.modifiedAtNs.toString(),
        ownerIdentity.changedAtNs.toString(),
        hash(payload.toString('utf8')),
      ],
      {
        cwd: lockRoot,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 4096,
        windowsHide: true,
      },
    )
    if ((JSON.parse(stdout) as { ok?: unknown }).ok !== true) return false
  } catch {
    payload.fill(0)
    return false
  }
  payload.fill(0)
  const quarantined = await lstatIdentity(quarantinePath)
  const quarantinedOwner = await lstatIdentity(join(quarantinePath, 'owner.json'))
  if (
    quarantined?.type !== 'directory' ||
    quarantined.device !== directoryIdentity.device ||
    quarantined.inode !== directoryIdentity.inode ||
    quarantinedOwner?.type !== 'file' ||
    !sameIdentity(quarantinedOwner, ownerIdentity) ||
    JSON.stringify(await readdir(quarantinePath)) !== JSON.stringify(['owner.json'])
  ) {
    return false
  }
  await unlink(join(quarantinePath, 'owner.json'))
  await rmdir(quarantinePath)
  await syncDirectory(lockRoot)
  return true
}

async function assertInstallLease(lease: InstallLease): Promise<void> {
  const identity = await lstatIdentity(lease.path)
  if (
    !identity ||
    identity.type !== 'directory' ||
    identity.device !== lease.device ||
    identity.inode !== lease.inode
  ) {
    throw new RecoveryPlanError('lock', 'RECOVERY_INSTALL_LEASE_LOST', 'Install lease was lost')
  }
  const before = await lstatIdentity(lease.ownerPath)
  if (!sameIdentity(before, lease.ownerIdentity)) {
    throw new RecoveryPlanError('lock', 'RECOVERY_INSTALL_LEASE_LOST', 'Install lease was lost')
  }
  const payload = await readBoundedRegularFile(lease.ownerPath, 4096)
  try {
    const after = await lstatIdentity(lease.ownerPath)
    if (
      !sameIdentity(after, lease.ownerIdentity) ||
      payload.toString('utf8') !== lease.ownerPayload
    ) {
      throw new Error('owner changed')
    }
  } catch {
    throw new RecoveryPlanError('lock', 'RECOVERY_INSTALL_LEASE_LOST', 'Install lease was lost')
  } finally {
    payload.fill(0)
  }
}

async function updateInstallLeaseOwner(
  lease: InstallLease,
  activeCommand: LeaseOwnerRecord['activeCommand'],
): Promise<void> {
  await assertInstallLease(lease)
  const ownerPayload = leaseOwnerPayload({
    owner: lease.owner,
    pid: process.pid,
    createdAt: lease.createdAt,
    activeCommand,
  })
  const ownerIdentity = await atomicPublish({
    kind: 'file',
    destination: lease.ownerPath,
    expected: lease.ownerIdentity,
    payload: ownerPayload,
  })
  lease.ownerPayload = ownerPayload
  lease.ownerIdentity = ownerIdentity
  lease.activeCommand = activeCommand
  await syncDirectory(lease.path)
  await assertInstallLease(lease)
}

async function releaseInstallLease(lease: InstallLease): Promise<void> {
  await assertInstallLease(lease)
  const ownerPayload = Buffer.from(lease.ownerPayload)
  try {
    const owner = parseLeaseOwner(ownerPayload)
    if (!owner || owner.activeCommand !== null || lease.activeCommand !== null) {
      throw new RecoveryPlanError(
        'lock',
        'RECOVERY_INSTALL_ACTIVE_COMMAND',
        'An active installer command prevents recovery lease release',
      )
    }
  } finally {
    ownerPayload.fill(0)
  }
  await unlink(lease.ownerPath)
  await rmdir(lease.path)
  await syncDirectory(resolve(lease.path, '..'))
}

async function markAlreadyPresent(
  journal: InstallJournal,
  current: CurrentMachineInventory,
): Promise<boolean> {
  const installed = {
    'homebrew-tap': new Set(current.homebrew.taps),
    'homebrew-formula': new Set(current.homebrew.formulae),
    'homebrew-cask': new Set(current.homebrew.casks),
    'vscode-extension': new Set(current.vscode.extensions),
  }
  let changed = false
  for (const item of journal.items) {
    if (
      isActionItem(item) &&
      (item.status === 'pending' || item.status === 'failed') &&
      installed[item.kind].has(item.value)
    ) {
      item.status = 'already-present'
      item.issueCode = undefined
      changed = true
    }
  }
  return changed
}

function result(
  journal: InstallJournal,
  dryRun: boolean,
  startedAt: Date,
  endedAt: Date,
): RecoveryInstallResult {
  const failed = journal.items.filter(isActionItem).filter((item) => item.status === 'failed')
  const resolved = journal.items.filter(
    (item) => item.status === 'succeeded' || item.status === 'already-present',
  )
  const pending = journal.items.filter((item) => item.status === 'pending')
  const manualItems = journal.items.filter((item) => item.status === 'manual')
  const state =
    failed.length > 0
      ? resolved.length > 0 || manualItems.length > 0
        ? 'partial'
        : 'failure'
      : manualItems.length > 0
        ? 'warning'
        : 'success'
  const unsupported = failed.every((item) => item.issueCode === 'INSTALLER_BINARY_MISSING')
  const category =
    state === 'partial'
      ? 'partial'
      : state === 'failure'
        ? unsupported
          ? 'unsupported'
          : 'internal'
        : state === 'warning'
          ? 'warning'
          : 'success'
  const issues: RecoveryInstallResult['issues'] = failed.map((item) => ({
    code: item.issueCode ?? 'INSTALLER_COMMAND_FAILED',
    category:
      category === 'partial'
        ? ('partial' as const)
        : category === 'unsupported'
          ? ('unsupported' as const)
          : ('internal' as const),
    message: `Allowlisted install action failed: ${item.id}`,
    nextAction: 'Resolve the installer prerequisite and resume with the same approved plan',
  }))
  if (manualItems.length > 0) {
    issues.push({
      code: 'MANUAL_RECOVERY_REQUIRED',
      category: state === 'partial' ? 'partial' : 'warning',
      message: `${manualItems.length} recovery item(s) require manual action`,
      nextAction: 'Review every manual journal item before completing recovery',
    })
  }
  const counts = {
    total: journal.items.length,
    pending: pending.length,
    succeeded: journal.items.filter((item) => item.status === 'succeeded').length,
    alreadyPresent: journal.items.filter((item) => item.status === 'already-present').length,
    failed: failed.length,
    manual: manualItems.length,
    skipped: journal.items.filter((item) => item.status === 'skipped').length,
  }
  return {
    operation: 'recovery-install',
    state,
    category,
    dryRun,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    repositoryId: journal.repositoryId,
    pointId: journal.pointId,
    planFingerprint: journal.planFingerprint,
    items: journal.items,
    counts,
    issues,
    nextAction:
      manualItems.length > 0
        ? 'Complete the manual recovery items; automated installers will never execute them'
        : failed.length > 0 || pending.length > 0
          ? 'Resume with the same approved plan after resolving failed prerequisites'
          : null,
  }
}

async function runHomebrew(
  stateDirectory: string,
  journalPath: string,
  journal: InstallJournal,
  runner: InstallerCommandRunner,
  now: () => Date,
  assertLease: () => Promise<void>,
  lifecycle: InstallerCommandLifecycle,
): Promise<void> {
  const items = journal.items
    .filter(isActionItem)
    .filter(
      (item) =>
        item.phase === 'homebrew' && (item.status === 'pending' || item.status === 'failed'),
    )
  if (items.length === 0) return
  for (const item of items) {
    serializeJournal(journal)
    await assertLease()
    const brewfilePath = join(
      stateDirectory,
      `Brewfile.${journal.planFingerprint.slice(0, 16)}.${hash(item.id).slice(0, 16)}.${randomUUID()}.generated`,
    )
    await writeDurableExclusiveFile(brewfilePath, synthesizeBrewfile([item]))
    await syncDirectory(stateDirectory)
    await assertLease()
    let issueCode: string | undefined
    let preserveActiveCommand = false
    try {
      serializeJournal(journal)
      await lifecycle.launchPending(now().toISOString())
      const command = await runner(
        HOMEBREW_EXECUTABLE,
        ['bundle', '--file', brewfilePath],
        {
          timeoutMs: 5 * 60_000,
          maxOutputBytes: 1024 * 1024,
        },
        lifecycle,
      )
      if (command.exitCode !== 0) issueCode = 'HOMEBREW_BUNDLE_FAILED'
    } catch (error) {
      if (
        error instanceof RecoveryPlanError &&
        (error.code === 'INSTALLER_CHILD_UNREAPED' ||
          error.code === 'INSTALLER_CHILD_PID_PUBLICATION_FAILED')
      ) {
        preserveActiveCommand = true
        throw error
      }
      issueCode = error instanceof RecoveryPlanError ? error.code : 'INSTALLER_COMMAND_FAILED'
    } finally {
      if (!preserveActiveCommand) await lifecycle.childStopped()
      await unlink(brewfilePath).catch(() => undefined)
      await syncDirectory(stateDirectory).catch(() => undefined)
    }
    await assertLease()
    item.status = issueCode ? 'failed' : 'succeeded'
    if (issueCode) item.issueCode = issueCode
    else item.issueCode = undefined
    journal.updatedAt = now().toISOString()
    await writeJournal(journalPath, journal)
  }
}

async function runVSCode(
  journalPath: string,
  journal: InstallJournal,
  runner: InstallerCommandRunner,
  now: () => Date,
  assertLease: () => Promise<void>,
  lifecycle: InstallerCommandLifecycle,
): Promise<void> {
  const items = journal.items
    .filter(isActionItem)
    .filter(
      (item) => item.phase === 'vscode' && (item.status === 'pending' || item.status === 'failed'),
    )
  for (const item of items) {
    serializeJournal(journal)
    await assertLease()
    let succeeded = false
    let issueCode = 'INSTALLER_BINARY_MISSING'
    for (const executable of VSCODE_EXECUTABLE_CANDIDATES) {
      let preserveActiveCommand = false
      try {
        serializeJournal(journal)
        await lifecycle.launchPending(now().toISOString())
        const command = await runner(
          executable,
          ['--install-extension', item.value],
          {
            timeoutMs: 60_000,
            maxOutputBytes: 1024 * 1024,
          },
          lifecycle,
        )
        if (command.exitCode === 0) {
          succeeded = true
          break
        }
        issueCode = 'VSCODE_EXTENSION_INSTALL_FAILED'
        break
      } catch (error) {
        if (
          error instanceof RecoveryPlanError &&
          (error.code === 'INSTALLER_CHILD_UNREAPED' ||
            error.code === 'INSTALLER_CHILD_PID_PUBLICATION_FAILED')
        ) {
          preserveActiveCommand = true
          throw error
        }
        issueCode = error instanceof RecoveryPlanError ? error.code : 'INSTALLER_COMMAND_FAILED'
        if (issueCode !== 'INSTALLER_BINARY_MISSING') break
      } finally {
        if (!preserveActiveCommand) await lifecycle.childStopped()
      }
    }
    await assertLease()
    item.status = succeeded ? 'succeeded' : 'failed'
    if (succeeded) item.issueCode = undefined
    else item.issueCode = issueCode
    journal.updatedAt = now().toISOString()
    await writeJournal(journalPath, journal)
  }
}

export async function executeRecoveryInstallPlan(
  options: ExecuteRecoveryInstallOptions,
  dependencies: RecoveryInstallDependencies = {},
): Promise<RecoveryInstallResult> {
  assertSupportedRecoverySystem(options)
  const startedAt = safeNow(options.now)
  const phases = normalizePhases(options.phases)
  if (options.invocation === 'daemon') {
    throw new RecoveryPlanError(
      'unsupported',
      'DAEMON_INSTALL_FORBIDDEN',
      'Recovery installers may run only from an explicit interactive CLI invocation',
    )
  }
  const generatePlan = dependencies.generatePlan ?? generateRecoveryPlan
  const planFingerprint = options.approvedPlanFingerprint
  if (!options.execute) {
    const plan = await generatePlan(options)
    const journal = createJournal(plan, phases, startedAt)
    return result(journal, true, startedAt, safeNow(options.now))
  }
  if (
    options.invocation !== 'interactive-cli' ||
    !planFingerprint ||
    !HASH_PATTERN.test(planFingerprint)
  ) {
    throw new RecoveryPlanError(
      'cancelled',
      'PLAN_APPROVAL_REQUIRED',
      'Install execution requires an exact reviewed plan fingerprint in interactive CLI mode',
    )
  }
  const confirmed = new Set(options.confirmedPhases ?? [])
  if (phases.some((phase) => !confirmed.has(phase))) {
    throw new RecoveryPlanError(
      'cancelled',
      'PHASE_CONFIRMATION_REQUIRED',
      'Every selected install phase requires explicit confirmation',
    )
  }
  if (!options.stateDirectory) {
    throw new RecoveryPlanError(
      'configuration',
      'PRIVATE_INSTALL_STATE_REQUIRED',
      'Install execution requires an explicit private state directory',
    )
  }
  await assertPrivateStateDirectory(options.stateDirectory)
  const stateDirectory = resolve(options.stateDirectory)
  const statePath = await realpath(stateDirectory)
  const repositoryPath = await realpath(resolve(options.repositoryPath))
  if (pathsOverlap(statePath, repositoryPath)) {
    throw new RecoveryPlanError(
      'destination',
      'INSTALL_STATE_REPOSITORY_OVERLAP',
      'Install state directory must not overlap repository state',
    )
  }
  const plan = await generatePlan(options)
  if (plan.fingerprint !== planFingerprint) {
    throw new RecoveryPlanError(
      'cancelled',
      'PLAN_FINGERPRINT_MISMATCH',
      'Current authenticated recovery plan does not match the reviewed fingerprint',
    )
  }
  const proposedJournal = createJournal(plan, phases, startedAt)
  const stagingPath = await realpath(plan.staging.path)
  if (pathsOverlap(statePath, stagingPath)) {
    throw new RecoveryPlanError(
      'destination',
      'INSTALL_STATE_STAGING_OVERLAP',
      'Install state directory must not overlap authenticated staging',
    )
  }
  const lockRoot = await resolveAuthoritativeLockRoot(dependencies.lockRoot)
  if (
    pathsOverlap(lockRoot, repositoryPath) ||
    pathsOverlap(lockRoot, statePath) ||
    pathsOverlap(lockRoot, stagingPath)
  ) {
    throw new RecoveryPlanError(
      'destination',
      'RECOVERY_LOCK_ROOT_OVERLAP',
      'The authoritative recovery lock root must not overlap repository, staging, or journal state',
    )
  }
  const path = join(statePath, journalName(planFingerprint, phases))
  const leaseName = recoveryInstallLeaseBasename(
    plan.repository.id,
    plan.recoveryPoint.id,
    planFingerprint,
  ).slice(1, -'.lock'.length)
  const lease = await acquireInstallLease(
    lockRoot,
    leaseName,
    startedAt,
    dependencies.beforeStaleLeaseQuarantine,
    dependencies.beforeInstallLeasePublish,
  )
  let completed: RecoveryInstallResult | undefined
  let operationError: unknown
  try {
    let journal = await readJournal(path)
    if (!journal) {
      journal = proposedJournal
      await assertInstallLease(lease)
      await writeJournal(path, journal)
    }
    await validateJournalBinding(options, journal, planFingerprint, phases)
    await assertInstallLease(lease)
    const current = await (dependencies.collectCurrentInventory ?? collectCurrentMachineInventory)()
    if (await markAlreadyPresent(journal, current)) {
      journal.updatedAt = safeNow(options.now).toISOString()
      await assertInstallLease(lease)
      await writeJournal(path, journal)
    }
    const runner = dependencies.commandRunner ?? runInstallerCommand
    const now = (): Date => safeNow(options.now)
    const checkLease = () => assertInstallLease(lease)
    const lifecycle: InstallerCommandLifecycle = {
      launchPending: async (startedAt) => {
        await updateInstallLeaseOwner(lease, {
          state: 'launch-pending',
          pid: process.pid,
          startedAt,
        })
      },
      childStarted: async (pid, expiresAt) => {
        try {
          await dependencies.beforeInstallerChildPidPublish?.()
          await updateInstallLeaseOwner(lease, { state: 'running', pid, expiresAt })
        } catch {
          throw new RecoveryPlanError(
            'lock',
            'INSTALLER_CHILD_PID_PUBLICATION_FAILED',
            'Installer child PID could not be published durably to the recovery lease',
          )
        }
      },
      childStopped: async () => {
        if (lease.activeCommand === null) await assertInstallLease(lease)
        else await updateInstallLeaseOwner(lease, null)
      },
    }
    if (phases.includes('homebrew')) {
      await runHomebrew(statePath, path, journal, runner, now, checkLease, lifecycle)
    }
    if (phases.includes('vscode')) {
      await runVSCode(path, journal, runner, now, checkLease, lifecycle)
    }
    await assertInstallLease(lease)
    completed = result(journal, false, startedAt, now())
  } catch (error) {
    operationError = error
  }
  let releaseError: unknown
  try {
    await releaseInstallLease(lease)
  } catch (error) {
    releaseError = error
  }
  if (operationError) throw operationError
  if (!completed) throw new Error('Recovery install ended without a result')
  if (releaseError) {
    return {
      ...completed,
      state: 'degraded',
      category: 'lock',
      issues: [
        ...completed.issues,
        {
          code: 'RECOVERY_INSTALL_LEASE_RELEASE_FAILED',
          category: 'lock',
          message: 'Install actions were journaled, but the execution lease could not be released',
          nextAction: 'Resume the same approved plan; stale lease recovery will converge safely',
        },
      ],
      nextAction: 'Resume the same approved plan; stale lease recovery will converge safely',
    }
  }
  return completed
}

export function recoveryInstallJournalBasename(
  planFingerprint: string,
  phases: InstallPhase[],
): string {
  if (!HASH_PATTERN.test(planFingerprint)) throw new Error('Invalid plan fingerprint')
  return basename(journalName(planFingerprint, normalizePhases(phases)))
}

export function recoveryInstallLeaseBasename(
  repositoryId: string,
  pointId: string,
  planFingerprint: string,
): string {
  if (!repositoryId || !pointId || !HASH_PATTERN.test(planFingerprint)) {
    throw new Error('Invalid recovery install lease binding')
  }
  return `.recovery-install-${hash(`${repositoryId}\0${pointId}\0${planFingerprint}`)}.lock`
}

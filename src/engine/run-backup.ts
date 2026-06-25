import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Config } from '../config/types.js'
import { getEnabledPlugins } from '../plugin/loader.js'
import { preparePlugins } from '../plugin/prepare.js'
import type { PluginManifest } from '../plugin/types.js'
import { expandPath, getBackupRoot } from '../util/path.js'
import { clearProgressLine, renderPluginDone, renderPluginProgress } from '../util/progress.js'
import {
  type FileDiff,
  type SkippedPath,
  diffWithLastSnapshotDetailed,
  skippedPathReason,
} from './diff.js'
import { pruneSnapshotsDetailed } from './prune.js'
import {
  type SnapshotSyncAction,
  applyDiffsToSnapshot,
  ensureBackupRoot,
  getLatestSnapshotDir,
  snapshotTimestamp,
} from './snapshot.js'

export interface PluginBackupRow {
  name: string
  unchanged: number
  updated: number
  new: number
  note?: string
}

export interface BackupPlan {
  backupRoot: string
  latestSnapshot: string | null
  pluginPlans: PluginPlan[]
  changes: string[]
  skippedPaths: SkippedPath[]
  rows: PluginBackupRow[]
}

export interface BackupRunResult {
  snapshotName: string | null
  backupRoot: string
  linked: number
  copied: number
  pruned: number
  pruneFailed: string[]
  pluginResults: PluginSyncResult[]
  plugins: PluginBackupRow[]
  changes: string[]
  skippedPaths: SkippedPath[]
  dryRun: boolean
}

export interface PluginSyncResult {
  name: string
  linked: number
  copied: number
}

export interface BackupResult {
  snapshotName: string
  backupRoot: string
  allSources: string[]
}

interface PluginPlan {
  plugin: PluginManifest
  diffs: FileDiff[]
  row: PluginBackupRow
}

export interface BackupProgressHandlers {
  onPrepareStart?: (pluginName: string, current: number, total: number) => void
  onPrepareDone?: (pluginName: string, current: number, total: number) => void
  onAnalyzeStart?: (pluginName: string, current: number, total: number) => void
  onAnalyze?: (completed: number, total: number, pluginName: string) => void
  onSyncStart?: (pluginName: string, completed: number, total: number, fileTotal: number) => void
  onSyncFile?: (event: BackupFileSyncProgress) => void
  onSync?: (completed: number, total: number, pluginName: string, result: PluginSyncResult) => void
}

export interface BackupFileSyncProgress {
  pluginName: string
  action: SnapshotSyncAction
  path: string
  current: number
  total: number
  linked: number
  copied: number
}

async function getStatError(filePath: string): Promise<unknown | null> {
  try {
    await stat(filePath)
    return null
  } catch (err) {
    return err
  }
}

async function filterValidDiffs(
  diffs: FileDiff[],
): Promise<{ diffs: FileDiff[]; skipped: SkippedPath[] }> {
  const valid: FileDiff[] = []
  const skipped: SkippedPath[] = []
  for (const diff of diffs) {
    const statError = diff.type === 'added' ? await getStatError(diff.path) : null
    if (statError) {
      skipped.push({ path: diff.path, reason: skippedPathReason(statError) })
      continue
    }
    valid.push(diff)
  }
  return { diffs: valid, skipped }
}

function countDiffStats(diffs: FileDiff[]): Pick<PluginBackupRow, 'unchanged' | 'updated' | 'new'> {
  return {
    unchanged: diffs.filter((d) => d.type === 'unchanged').length,
    updated: diffs.filter((d) => d.type === 'modified').length,
    new: diffs.filter((d) => d.type === 'added').length,
  }
}

function getMacAppsNote(plugin: PluginManifest): string | undefined {
  if (plugin.name !== 'mac-apps' || !plugin.paths[0]) return undefined
  try {
    const inventory = JSON.parse(readFileSync(expandPath(plugin.paths[0]), 'utf-8')) as {
      appCount?: number
    }
    if (typeof inventory.appCount === 'number') return `${inventory.appCount} apps`
  } catch {
    // ignore
  }
  return undefined
}

/// Prepare dynamic plugin outputs and diff each enabled plugin.
export async function prepareAndPlan(
  config: Config,
  options?: { skipPrepare?: boolean; progress?: BackupProgressHandlers },
): Promise<BackupPlan> {
  const plugins = getEnabledPlugins(config.plugins)
  const allSources = plugins.flatMap((plugin) => plugin.paths.map(expandPath))

  if (allSources.length === 0) {
    throw new Error('No sources to back up. Enable plugins in `restore-cli config`.')
  }

  if (!options?.skipPrepare) {
    await preparePlugins(plugins, {
      onPrepareStart: (pluginName, current, total) => {
        options?.progress?.onPrepareStart?.(pluginName, current, total)
      },
      onPrepareDone: (pluginName, current, total) => {
        options?.progress?.onPrepareDone?.(pluginName, current, total)
      },
    })
  }

  const backupRoot = getBackupRoot(config.destination.path)
  const latestSnapshot = await getLatestSnapshotDir(backupRoot)
  const pluginPlans: PluginPlan[] = []
  const changes: string[] = []
  const skippedPaths: SkippedPath[] = []
  const total = plugins.length
  const renderInlineProgress = !options?.progress?.onAnalyzeStart && !options?.progress?.onAnalyze

  for (let i = 0; i < plugins.length; i++) {
    const plugin = plugins[i]
    const paths = plugin.paths.map(expandPath)

    options?.progress?.onAnalyzeStart?.(plugin.name, i + 1, total)
    const diffResult = await diffWithLastSnapshotDetailed(paths, latestSnapshot)
    const filtered = await filterValidDiffs(diffResult.diffs)
    const diffs = filtered.diffs
    skippedPaths.push(...diffResult.skipped, ...filtered.skipped)
    pluginPlans.push({
      plugin,
      diffs,
      row: {
        name: plugin.name,
        ...countDiffStats(diffs),
        note: getMacAppsNote(plugin),
      },
    })
    for (const diff of diffs) {
      if (diff.type === 'modified' || diff.type === 'added') {
        changes.push(diff.path)
      }
    }

    options?.progress?.onAnalyze?.(i + 1, total, plugin.name)
    if (renderInlineProgress) {
      renderPluginProgress(i + 1, total, plugin.name, 'Analyzing')
    }
  }

  if (renderInlineProgress) {
    clearProgressLine()
  }

  return {
    backupRoot,
    latestSnapshot,
    pluginPlans,
    changes,
    skippedPaths,
    rows: pluginPlans.map((plan) => plan.row),
  }
}

/// Sync a prepared backup plan into a new snapshot, one plugin at a time.
export async function executeBackupPlan(
  plan: BackupPlan,
  maxSnapshots: number,
  progress?: BackupProgressHandlers,
): Promise<{
  snapshotName: string
  linked: number
  copied: number
  pruned: number
  pruneFailed: string[]
  pluginResults: PluginSyncResult[]
}> {
  await ensureBackupRoot(plan.backupRoot)
  const timestamp = snapshotTimestamp()
  const snapshotPath = resolve(plan.backupRoot, timestamp)
  const pendingSnapshotPath = resolve(plan.backupRoot, `${timestamp}.in-progress`)
  await mkdir(pendingSnapshotPath, { recursive: true })

  let linked = 0
  let copied = 0
  const pluginResults: PluginSyncResult[] = []
  const total = plan.pluginPlans.length
  const renderInlineProgress = !progress?.onSyncStart && !progress?.onSyncFile

  try {
    for (let i = 0; i < plan.pluginPlans.length; i++) {
      const pluginPlan = plan.pluginPlans[i]
      if (renderInlineProgress) {
        renderPluginProgress(i + 1, total, pluginPlan.plugin.name, 'Syncing')
      }
      progress?.onSyncStart?.(pluginPlan.plugin.name, i, total, pluginPlan.diffs.length)

      const stats = await applyDiffsToSnapshot(
        pendingSnapshotPath,
        pluginPlan.diffs,
        plan.latestSnapshot,
        {
          onFileStart: (event) => {
            progress?.onSyncFile?.({
              pluginName: pluginPlan.plugin.name,
              ...event,
            })
          },
        },
      )
      linked += stats.linked
      copied += stats.copied
      const pluginResult = {
        name: pluginPlan.plugin.name,
        linked: stats.linked,
        copied: stats.copied,
      }
      pluginResults.push(pluginResult)

      progress?.onSync?.(i + 1, total, pluginPlan.plugin.name, pluginResult)
      if (renderInlineProgress) {
        renderPluginDone(pluginPlan.plugin.name, stats.linked, stats.copied)
      }
    }
  } catch (err) {
    await rm(pendingSnapshotPath, { recursive: true, force: true })
    throw err
  }

  clearProgressLine()
  await rename(pendingSnapshotPath, snapshotPath)

  const pruneResult = await pruneSnapshotsDetailed(plan.backupRoot, maxSnapshots)
  return {
    snapshotName: timestamp,
    linked,
    copied,
    pruned: pruneResult.removed,
    pruneFailed: pruneResult.failed,
    pluginResults,
  }
}

export async function runBackup(
  config: Config,
  options?: {
    dryRun?: boolean
    skipPrepare?: boolean
    progress?: BackupProgressHandlers
  },
): Promise<BackupRunResult> {
  const plan = await prepareAndPlan(config, {
    skipPrepare: options?.dryRun ? true : options?.skipPrepare,
    progress: options?.progress,
  })

  if (options?.dryRun) {
    return {
      snapshotName: null,
      backupRoot: plan.backupRoot,
      linked: 0,
      copied: 0,
      pruned: 0,
      pruneFailed: [],
      pluginResults: [],
      plugins: plan.rows,
      changes: plan.changes,
      skippedPaths: plan.skippedPaths,
      dryRun: true,
    }
  }

  const result = await executeBackupPlan(plan, config.maxSnapshots, options?.progress)
  return {
    snapshotName: result.snapshotName,
    backupRoot: plan.backupRoot,
    linked: result.linked,
    copied: result.copied,
    pruned: result.pruned,
    pruneFailed: result.pruneFailed,
    pluginResults: result.pluginResults,
    plugins: plan.rows,
    changes: plan.changes,
    skippedPaths: plan.skippedPaths,
    dryRun: false,
  }
}

/// Run a full backup for the given config (used by daemon).
export async function executeBackup(
  config: Config,
  options?: { skipPrepare?: boolean },
): Promise<BackupResult> {
  const result = await runBackup(config, { skipPrepare: options?.skipPrepare })
  if (!result.snapshotName) {
    throw new Error('Backup did not produce a snapshot')
  }
  return {
    snapshotName: result.snapshotName,
    backupRoot: result.backupRoot,
    allSources: getEnabledPlugins(config.plugins).flatMap((plugin) => plugin.paths.map(expandPath)),
  }
}

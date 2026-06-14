import { readFileSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Config } from '../config/types.js'
import { getEnabledPlugins } from '../plugin/loader.js'
import { preparePlugins } from '../plugin/prepare.js'
import type { PluginManifest } from '../plugin/types.js'
import { expandPath, getBackupRoot } from '../util/path.js'
import { clearProgressLine, renderPluginProgress } from '../util/progress.js'
import { type FileDiff, diffWithLastSnapshot } from './diff.js'
import { pruneSnapshots } from './prune.js'
import {
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
  rows: PluginBackupRow[]
}

export interface BackupRunResult {
  snapshotName: string | null
  backupRoot: string
  linked: number
  copied: number
  pruned: number
  plugins: PluginBackupRow[]
  changes: string[]
  dryRun: boolean
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
  onAnalyze?: (completed: number, total: number, pluginName: string) => void
  onSync?: (completed: number, total: number, pluginName: string) => void
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function filterValidDiffs(diffs: FileDiff[]): Promise<FileDiff[]> {
  const valid: FileDiff[] = []
  for (const diff of diffs) {
    if (diff.type === 'added' && !(await fileExists(diff.path))) continue
    valid.push(diff)
  }
  return valid
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
    await preparePlugins(plugins)
  }

  const backupRoot = getBackupRoot(config.destination.path)
  const latestSnapshot = await getLatestSnapshotDir(backupRoot)
  const pluginPlans: PluginPlan[] = []
  const changes: string[] = []
  const total = plugins.length

  for (let i = 0; i < plugins.length; i++) {
    const plugin = plugins[i]
    const paths = plugin.paths.map(expandPath)

    const diffs = await filterValidDiffs(await diffWithLastSnapshot(paths, latestSnapshot))
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
    renderPluginProgress(i + 1, total, plugin.name, 'Analyzing')
  }

  clearProgressLine()

  return {
    backupRoot,
    latestSnapshot,
    pluginPlans,
    changes,
    rows: pluginPlans.map((plan) => plan.row),
  }
}

/// Sync a prepared backup plan into a new snapshot, one plugin at a time.
export async function executeBackupPlan(
  plan: BackupPlan,
  maxSnapshots: number,
  progress?: BackupProgressHandlers,
): Promise<{ snapshotName: string; linked: number; copied: number; pruned: number }> {
  await ensureBackupRoot(plan.backupRoot)
  const timestamp = snapshotTimestamp()
  const snapshotPath = resolve(plan.backupRoot, timestamp)
  await mkdir(snapshotPath, { recursive: true })

  let linked = 0
  let copied = 0
  const total = plan.pluginPlans.length

  for (let i = 0; i < plan.pluginPlans.length; i++) {
    const pluginPlan = plan.pluginPlans[i]

    const stats = await applyDiffsToSnapshot(snapshotPath, pluginPlan.diffs, plan.latestSnapshot)
    linked += stats.linked
    copied += stats.copied

    progress?.onSync?.(i + 1, total, pluginPlan.plugin.name)
    renderPluginProgress(i + 1, total, pluginPlan.plugin.name, 'Syncing')
  }

  clearProgressLine()

  const pruned = await pruneSnapshots(plan.backupRoot, maxSnapshots)
  return { snapshotName: timestamp, linked, copied, pruned }
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
    skipPrepare: options?.skipPrepare,
    progress: options?.progress,
  })

  if (options?.dryRun) {
    return {
      snapshotName: null,
      backupRoot: plan.backupRoot,
      linked: 0,
      copied: 0,
      pruned: 0,
      plugins: plan.rows,
      changes: plan.changes,
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
    plugins: plan.rows,
    changes: plan.changes,
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

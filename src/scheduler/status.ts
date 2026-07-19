import { listSchedulerHistory } from './history.js'
import { getLaunchAgentStatus } from './launchd.js'
import {
  type LaunchAgentStatus,
  SCHEDULER_DEGRADED_AFTER_MS,
  type SchedulerRunRecord,
  type SchedulerStatusResult,
} from './types.js'

export interface SchedulerStatusDependencies {
  launchAgentStatus(): Promise<LaunchAgentStatus>
  history(): Promise<SchedulerRunRecord[]>
  now(): Date
}

const DEFAULT_DEPENDENCIES: SchedulerStatusDependencies = {
  launchAgentStatus: () => getLaunchAgentStatus(),
  history: () => listSchedulerHistory(),
  now: () => new Date(),
}

function latestHealthy(records: readonly SchedulerRunRecord[]): string | null {
  return (
    records
      .flatMap((record) =>
        record.latestHealthyAt
          ? [record.latestHealthyAt]
          : record.healthyPublished
            ? [record.endedAt]
            : [],
      )
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
  )
}

export async function getSchedulerStatus(
  intervalHours: number,
  overrides: Partial<SchedulerStatusDependencies> = {},
): Promise<SchedulerStatusResult> {
  if (
    !Number.isFinite(intervalHours) ||
    intervalHours < 0 ||
    !Number.isSafeInteger(intervalHours * 60 * 60)
  ) {
    throw new Error('Scheduler interval is invalid')
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const now = dependencies.now()
  if (!Number.isFinite(now.getTime())) throw new Error('Scheduler clock is invalid')
  let launchd: LaunchAgentStatus
  let history: SchedulerRunRecord[]
  try {
    ;[launchd, history] = await Promise.all([
      dependencies.launchAgentStatus(),
      dependencies.history(),
    ])
  } catch {
    return {
      operation: 'scheduler-status',
      state: 'failure',
      category: 'integrity',
      enabled: intervalHours > 0,
      installed: false,
      loaded: false,
      intervalHours,
      nextScheduledAt: null,
      lastRun: null,
      latestHealthyAt: null,
      rpoAgeMs: null,
      degradedAfterMs: SCHEDULER_DEGRADED_AFTER_MS,
      degraded: true,
      historyEntries: 0,
      issues: [
        {
          code: 'SCHEDULER_STATUS_UNAVAILABLE',
          category: 'integrity',
          message: 'Scheduler state or local history could not be read safely',
          nextAction: 'Inspect the LaunchAgent and scheduler history before restarting it',
        },
      ],
    }
  }
  const enabled = intervalHours > 0
  const lastRun = history[0] ?? null
  const latestHealthyAt = latestHealthy(history)
  const rpoAgeMs = latestHealthyAt ? Math.max(0, now.getTime() - Date.parse(latestHealthyAt)) : null
  const rpoDegraded = rpoAgeMs === null || rpoAgeMs > SCHEDULER_DEGRADED_AFTER_MS
  const issues: SchedulerStatusResult['issues'] = []
  if (enabled && (!launchd.installed || !launchd.loaded)) {
    issues.push({
      code: 'SCHEDULER_NOT_ACTIVE',
      category: 'warning',
      message: 'Scheduled backup is configured but its LaunchAgent is not active',
      nextAction: 'Run restore-cli daemon start',
    })
  }
  if (!enabled && (launchd.installed || launchd.loaded)) {
    issues.push({
      code: 'SCHEDULER_DISABLE_INCOMPLETE',
      category: 'warning',
      message: 'Scheduled backup is disabled but a LaunchAgent remains active',
      nextAction: 'Run restore-cli daemon stop',
    })
  }
  if (rpoDegraded) {
    issues.push({
      code: 'RPO_DEGRADED',
      category: 'warning',
      message: 'No successful healthy backup exists within the 24-hour RPO',
      nextAction: 'Connect the repository target and run a manual backup',
    })
  }
  if (lastRun?.notification === 'failed') {
    issues.push({
      code: 'SCHEDULER_NOTIFICATION_FAILED',
      category: 'warning',
      message: 'The most recent scheduler alert could not be delivered',
      nextAction: 'Review scheduler history and macOS notification permissions',
    })
  }
  const intervalMs = intervalHours * 60 * 60 * 1000
  const nextScheduledAt =
    enabled && launchd.loaded && lastRun
      ? new Date(Date.parse(lastRun.startedAt) + intervalMs).toISOString()
      : null
  return {
    operation: 'scheduler-status',
    state: issues.length > 0 ? 'degraded' : 'success',
    category: issues[0]?.category ?? 'success',
    enabled,
    installed: launchd.installed,
    loaded: launchd.loaded,
    intervalHours,
    nextScheduledAt,
    lastRun,
    latestHealthyAt,
    rpoAgeMs,
    degradedAfterMs: SCHEDULER_DEGRADED_AFTER_MS,
    degraded: issues.length > 0,
    historyEntries: history.length,
    issues,
  }
}

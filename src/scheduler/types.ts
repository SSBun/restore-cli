import type { OperationCategory, OperationState } from '../repository/index.js'

export const SCHEDULER_HISTORY_VERSION = 1 as const
export const SCHEDULER_DEGRADED_AFTER_MS = 24 * 60 * 60 * 1000
export const SCHEDULER_HISTORY_LIMIT = 100

export type SchedulerNotificationState = 'not-required' | 'sent' | 'failed'

export interface SchedulerRunRecord {
  schemaVersion: typeof SCHEDULER_HISTORY_VERSION
  operation: 'scheduled-backup'
  state: OperationState
  category: OperationCategory
  repositoryId: string | null
  pointId: string | null
  startedAt: string
  endedAt: string
  durationMs: number
  healthyPublished: boolean
  latestHealthyAt: string | null
  degraded: boolean
  issueCode: string | null
  notification: SchedulerNotificationState
}

export interface LaunchAgentStatus {
  installed: boolean
  loaded: boolean
}

export interface SchedulerStatusResult {
  operation: 'scheduler-status'
  state: OperationState
  category: OperationCategory
  enabled: boolean
  installed: boolean
  loaded: boolean
  intervalHours: number
  nextScheduledAt: string | null
  lastRun: SchedulerRunRecord | null
  latestHealthyAt: string | null
  rpoAgeMs: number | null
  degradedAfterMs: number
  degraded: boolean
  historyEntries: number
  issues: Array<{
    code: string
    category: Exclude<OperationCategory, 'success'>
    message: string
    nextAction: string
  }>
}

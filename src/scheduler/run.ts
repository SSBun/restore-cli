import { lstat } from 'node:fs/promises'
import { loadConfigStrict, resolveBackupConfiguration } from '../config/loader.js'
import type { ResolvedBackupConfiguration } from '../config/loader.js'
import { createV1RecoveryPoint } from '../engine/v1-backup.js'
import { getV1Status } from '../engine/v1-stat.js'
import { preparePlugins } from '../plugin/prepare.js'
import { MacOsKeychainCredentialProvider } from '../protection/index.js'
import type { CredentialProvider } from '../protection/index.js'
import { createOperationResult } from '../repository/index.js'
import type { OperationCategory, OperationResult } from '../repository/index.js'
import { listSchedulerHistory, recordSchedulerRun } from './history.js'
import { sendLocalNotification } from './notification.js'
import {
  SCHEDULER_DEGRADED_AFTER_MS,
  SCHEDULER_HISTORY_VERSION,
  type SchedulerNotificationState,
  type SchedulerRunRecord,
} from './types.js'

export interface ScheduledBackupDependencies {
  resolveConfiguration(): ResolvedBackupConfiguration
  createRecoveryPoint: typeof createV1RecoveryPoint
  inspectStatus: typeof getV1Status
  prepare: typeof preparePlugins
  credentialProvider(): CredentialProvider
  targetExists(path: string): Promise<boolean>
  listHistory(): Promise<SchedulerRunRecord[]>
  recordHistory(record: SchedulerRunRecord): Promise<unknown>
  notify(input: { title: string; message: string }): Promise<boolean>
  now(): Date
}

const DEFAULT_DEPENDENCIES: ScheduledBackupDependencies = {
  resolveConfiguration: () => resolveBackupConfiguration(loadConfigStrict()),
  createRecoveryPoint: createV1RecoveryPoint,
  inspectStatus: getV1Status,
  prepare: preparePlugins,
  credentialProvider: () => new MacOsKeychainCredentialProvider(),
  targetExists: async (path) => {
    try {
      const stat = await lstat(path)
      return stat.isDirectory() && !stat.isSymbolicLink()
    } catch {
      return false
    }
  },
  listHistory: () => listSchedulerHistory(),
  recordHistory: (record) => recordSchedulerRun(record),
  notify: (input) => sendLocalNotification(input),
  now: () => new Date(),
}

function safeNow(now: () => Date): Date {
  const value = now()
  if (!Number.isFinite(value.getTime())) throw new Error('Scheduler clock is invalid')
  return value
}

function schedulerFailure(
  startedAt: string,
  endedAt: string,
  category: Exclude<OperationCategory, 'success' | 'warning' | 'partial'>,
  code: string,
  repositoryId?: string,
): OperationResult {
  return createOperationResult({
    operation: 'backup',
    state: 'failure',
    category,
    ...(repositoryId ? { repositoryId } : {}),
    startedAt,
    endedAt,
    issues: [
      {
        code,
        category,
        message: 'Scheduled backup could not complete safely',
        nextAction: 'Run restore-cli status and retry a manual backup after resolving the issue',
      },
    ],
  })
}

function disabledResult(
  startedAt: string,
  endedAt: string,
  repositoryId?: string,
): OperationResult {
  return createOperationResult({
    operation: 'backup',
    state: 'warning',
    category: 'warning',
    ...(repositoryId ? { repositoryId } : {}),
    startedAt,
    endedAt,
    issues: [
      {
        code: 'SCHEDULER_DISABLED',
        category: 'warning',
        message: 'Scheduled backup is disabled',
        nextAction: 'Run restore-cli daemon start after setting a non-zero interval',
      },
    ],
  })
}

function latestKnownHealthy(history: readonly SchedulerRunRecord[]): string | null {
  const candidates = history.flatMap((entry) => {
    if (entry.latestHealthyAt) return [entry.latestHealthyAt]
    return entry.healthyPublished ? [entry.endedAt] : []
  })
  return candidates.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
}

function notificationRequired(result: OperationResult, degraded: boolean): boolean {
  if (result.state === 'failure' || result.state === 'partial' || result.state === 'degraded') {
    return true
  }
  if (degraded) return true
  return result.issues.some(
    (issue) =>
      issue.category === 'integrity' ||
      issue.code.includes('TARGET') ||
      issue.code.includes('VERIFICATION'),
  )
}

function resultIssueCode(result: OperationResult, degraded: boolean): string | null {
  return result.issues[0]?.code ?? (degraded ? 'RPO_DEGRADED' : null)
}

export async function runScheduledBackup(
  overrides: Partial<ScheduledBackupDependencies> = {},
): Promise<SchedulerRunRecord> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const started = safeNow(dependencies.now)
  const startedAt = started.toISOString()
  let history: SchedulerRunRecord[] = []
  let historyReadable = true
  try {
    history = await dependencies.listHistory()
  } catch {
    historyReadable = false
  }
  let resolved: ResolvedBackupConfiguration | undefined
  let result: OperationResult
  let latestHealthyAt = latestKnownHealthy(history)
  let confirmedHealthyPointId: string | null = null

  try {
    resolved = dependencies.resolveConfiguration()
    const repository = resolved.config.repository
    if (!repository || resolved.plugins.length === 0) {
      result = schedulerFailure(
        startedAt,
        safeNow(dependencies.now).toISOString(),
        'configuration',
        'SCHEDULER_CONFIGURATION_INVALID',
        repository?.id,
      )
    } else if (resolved.config.daemon.intervalHours === 0) {
      result = disabledResult(startedAt, safeNow(dependencies.now).toISOString(), repository.id)
    } else if (!(await dependencies.targetExists(resolved.repositoryPath))) {
      result = schedulerFailure(
        startedAt,
        safeNow(dependencies.now).toISOString(),
        'destination',
        'SCHEDULER_TARGET_UNAVAILABLE',
        repository.id,
      )
    } else {
      const plugins = resolved.plugins
      result = await dependencies.createRecoveryPoint({
        repositoryPath: resolved.repositoryPath,
        expectedRepositoryId: repository.id,
        expectedProtection: repository.protection,
        ...(repository.protection === 'encrypted'
          ? { credentialProvider: dependencies.credentialProvider() }
          : {}),
        plan: resolved.plan,
        plaintextSecretAcceptances: resolved.config.plaintextSecretAcceptances,
        beforeCapture: async () => dependencies.prepare(plugins),
      })
      try {
        const status = await dependencies.inspectStatus({
          repositoryPath: resolved.repositoryPath,
          expectedRepositoryId: repository.id,
          expectedProtection: repository.protection,
          ...(repository.protection === 'encrypted'
            ? { credentialProvider: dependencies.credentialProvider() }
            : {}),
          schedulerIntervalHours: resolved.config.daemon.intervalHours,
          schedulerRunning: true,
        })
        confirmedHealthyPointId = status.recoveryPoints.latestHealthyId
        latestHealthyAt =
          status.recoveryPoints.latestHealthyAt ??
          (result.verificationScope === 'content' &&
          (result.state === 'success' || result.state === 'warning')
            ? result.endedAt
            : latestHealthyAt)
      } catch {
        if (
          result.verificationScope === 'content' &&
          (result.state === 'success' || result.state === 'warning')
        ) {
          latestHealthyAt = result.endedAt
        }
      }
    }
  } catch {
    result = schedulerFailure(
      startedAt,
      safeNow(dependencies.now).toISOString(),
      resolved ? 'internal' : 'configuration',
      resolved ? 'SCHEDULER_BACKUP_SERVICE_FAILED' : 'SCHEDULER_CONFIGURATION_INVALID',
      resolved?.config.repository?.id,
    )
  }

  const ended = new Date(result.endedAt)
  const ageMs = latestHealthyAt ? Math.max(0, ended.getTime() - Date.parse(latestHealthyAt)) : null
  const degraded = ageMs === null || ageMs > SCHEDULER_DEGRADED_AFTER_MS
  const shouldNotify = notificationRequired(result, degraded) || !historyReadable
  let notification: SchedulerNotificationState = 'not-required'
  if (shouldNotify) {
    try {
      const code = !historyReadable
        ? 'SCHEDULER_HISTORY_UNAVAILABLE'
        : (resultIssueCode(result, degraded) ?? 'SCHEDULED_BACKUP_FAILED')
      notification = (await dependencies.notify({
        title: 'Restore backup needs attention',
        message: `Scheduled backup reported ${code}. Run restore-cli status for details.`,
      }))
        ? 'sent'
        : 'failed'
    } catch {
      notification = 'failed'
    }
  }

  const healthyPublished =
    Boolean(result.pointId) &&
    (confirmedHealthyPointId === result.pointId ||
      (result.verificationScope === 'content' &&
        (result.state === 'success' || result.state === 'warning')))
  const record: SchedulerRunRecord = {
    schemaVersion: SCHEDULER_HISTORY_VERSION,
    operation: 'scheduled-backup',
    state: result.state,
    category: result.category,
    repositoryId: result.repositoryId ?? null,
    pointId: result.pointId ?? null,
    startedAt,
    endedAt: result.endedAt,
    durationMs: ended.getTime() - started.getTime(),
    healthyPublished,
    latestHealthyAt,
    degraded,
    issueCode: !historyReadable
      ? 'SCHEDULER_HISTORY_UNAVAILABLE'
      : resultIssueCode(result, degraded),
    notification,
  }
  await dependencies.recordHistory(record)
  return record
}

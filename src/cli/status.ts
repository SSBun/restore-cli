import type { Command } from 'commander'
import { loadConfigStrict } from '../config/loader.js'
import type { Config } from '../config/types.js'
import { isDaemonRunning } from '../daemon/lifecycle.js'
import { getBackupStat } from '../engine/stat.js'
import { getV1Status } from '../engine/v1-stat.js'
import type { V1StatusResult } from '../engine/v1-stat.js'
import { MacOsKeychainCredentialProvider } from '../protection/index.js'
import type { CredentialProvider } from '../protection/index.js'
import type { OperationCategory } from '../repository/index.js'
import { info } from '../util/log.js'
import { getBackupRoot } from '../util/path.js'

const EXIT_CODES: Record<OperationCategory, number> = {
  success: 0,
  warning: 2,
  partial: 3,
  configuration: 10,
  authentication: 11,
  lock: 12,
  source: 13,
  destination: 14,
  integrity: 15,
  unsupported: 16,
  cancelled: 17,
  internal: 20,
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  const digits = unitIndex === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

function formatDate(date: Date | null): string {
  return date ? date.toISOString() : 'never'
}

export interface StatusCommandDependencies {
  load(): Config
  legacyStat: typeof getBackupStat
  daemonRunning: typeof isDaemonRunning
  status: typeof getV1Status
  credentialProvider(): CredentialProvider
  writeStdout(value: string): void
  writeStderr(value: string): void
  setExitCode(value: number): void
}

const DEFAULT_DEPENDENCIES: StatusCommandDependencies = {
  load: loadConfigStrict,
  legacyStat: getBackupStat,
  daemonRunning: isDaemonRunning,
  status: getV1Status,
  credentialProvider: () => new MacOsKeychainCredentialProvider(),
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
  setExitCode: (value) => {
    process.exitCode = value
  },
}

export function registerStatusCommand(
  program: Command,
  overrides: Partial<StatusCommandDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  program
    .command('status')
    .description('Show current backup status')
    .action(async () => {
      const startedAt = new Date().toISOString()
      let config: Config
      try {
        config = dependencies.load()
      } catch {
        const endedAt = new Date().toISOString()
        const result = {
          operation: 'status',
          state: 'failure',
          category: 'configuration',
          startedAt,
          endedAt,
          repositoryId: null,
          repositoryLocation: null,
          protection: null,
          target: { state: 'unknown', capabilities: null },
          scheduler: {
            configured: false,
            state: 'unknown',
            intervalHours: null,
            nextScheduledAt: null,
          },
          recoveryPoints: {
            healthy: 0,
            partial: 0,
            failed: 0,
            latestId: null,
            latestHealthyId: null,
            latestHealthyAt: null,
          },
          rpo: { ageMs: null, degradedAfterMs: 86_400_000, degraded: true },
          verification: { structural: null, content: null },
          recentOperations: [],
          issues: [
            {
              code: 'STATUS_CONFIGURATION_INVALID',
              category: 'configuration',
              message: 'Status configuration could not be loaded safely',
              nextAction: 'Validate or initialize Restore configuration',
            },
          ],
          nextAction: 'Validate or initialize Restore configuration',
        }
        dependencies.writeStderr('status: STATUS_CONFIGURATION_INVALID')
        dependencies.writeStdout(JSON.stringify(result))
        dependencies.setExitCode(EXIT_CODES.configuration)
        return
      }
      const backupRoot = getBackupRoot(config.destination.path)
      if (config.repository) {
        try {
          const result = await dependencies.status({
            repositoryPath: backupRoot,
            expectedRepositoryId: config.repository.id,
            expectedProtection: config.repository.protection,
            ...(config.repository.protection === 'encrypted'
              ? { credentialProvider: dependencies.credentialProvider() }
              : {}),
            schedulerIntervalHours: config.daemon.intervalHours,
            schedulerRunning:
              config.daemon.intervalHours === 0 ? false : dependencies.daemonRunning(),
          })
          if (result.issues.length > 0) {
            dependencies.writeStderr(`status: ${result.issues[0]?.code ?? 'STATUS_DEGRADED'}`)
          }
          dependencies.writeStdout(JSON.stringify(result))
          dependencies.setExitCode(EXIT_CODES[result.category])
        } catch {
          dependencies.writeStderr('status: STATUS_SERVICE_FAILED')
          const now = new Date().toISOString()
          const result: V1StatusResult = {
            operation: 'status',
            state: 'failure',
            category: 'internal',
            startedAt: now,
            endedAt: now,
            repositoryId: config.repository.id,
            repositoryLocation: null,
            protection: {
              mode: config.repository.protection,
              state: config.repository.protection === 'encrypted' ? 'secure' : 'insecure',
            },
            target: { state: 'unavailable', capabilities: null },
            scheduler: {
              configured: config.daemon.intervalHours > 0,
              state: config.daemon.intervalHours > 0 ? 'unknown' : 'disabled',
              intervalHours: config.daemon.intervalHours,
              nextScheduledAt: null,
            },
            recoveryPoints: {
              healthy: 0,
              partial: 0,
              failed: 0,
              latestId: null,
              latestHealthyId: null,
              latestHealthyAt: null,
            },
            rpo: { ageMs: null, degradedAfterMs: 86_400_000, degraded: true },
            verification: { structural: null, content: null },
            recentOperations: [],
            issues: [
              {
                code: 'STATUS_SERVICE_FAILED',
                category: 'internal',
                message: 'Status service did not produce a safe result',
                nextAction: 'Run structural verification and inspect repository diagnostics',
              },
            ],
            nextAction: 'Run structural verification and inspect repository diagnostics',
          }
          dependencies.writeStdout(JSON.stringify(result))
          dependencies.setExitCode(EXIT_CODES.internal)
        }
        return
      }

      // 0.1.x compatibility remains human-readable and read-only until migration.
      const stat = await dependencies.legacyStat(backupRoot)
      const daemonState =
        config.daemon.intervalHours === 0
          ? 'disabled'
          : dependencies.daemonRunning()
            ? 'running'
            : 'stopped'

      info(`Destination: ${config.destination.name}`)
      info(`Backup root: ${stat.backupRoot}`)
      info(`Daemon: ${daemonState}`)
      info(`Snapshots: ${stat.snapshotCount}`)
      info(`Last backup: ${formatDate(stat.lastBackupAt)}`)
      if (stat.lastBackupName) info(`Last snapshot: ${stat.lastBackupName}`)
      info(`Latest snapshot size: ${formatBytes(stat.latestSnapshotBytes)}`)
      info(`Latest snapshot files: ${stat.latestSnapshotFiles}`)
      info(`Total backup size: ${formatBytes(stat.totalBackupBytes)}`)
      info(`Total backup files: ${stat.totalBackupFiles}`)
    })
}

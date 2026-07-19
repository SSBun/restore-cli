import { fileURLToPath } from 'node:url'
import type { Command } from 'commander'
import { loadConfigStrict } from '../config/loader.js'
import type { Config } from '../config/types.js'
import { startDaemon, stopDaemon } from '../daemon/scheduler.js'
import type { OperationCategory } from '../repository/index.js'
import type { LaunchAgentDefinition } from '../scheduler/launchd.js'
import { getSchedulerStatus } from '../scheduler/status.js'
import type { LaunchAgentStatus } from '../scheduler/types.js'

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

export interface DaemonCommandDependencies {
  load(): Config
  start(definition: LaunchAgentDefinition): Promise<LaunchAgentStatus>
  stop(): Promise<LaunchAgentStatus>
  status(intervalHours: number): ReturnType<typeof getSchedulerStatus>
  launchDefinition(intervalHours: number): LaunchAgentDefinition
  writeStdout(value: string): void
  writeStderr(value: string): void
  setExitCode(value: number): void
}

function defaultLaunchDefinition(intervalHours: number): LaunchAgentDefinition {
  const sourceMode = import.meta.url.endsWith('.ts')
  const worker = fileURLToPath(
    new URL(`../daemon/worker.${sourceMode ? 'ts' : 'js'}`, import.meta.url),
  )
  return {
    executable: process.execPath,
    arguments: [...(sourceMode ? process.execArgv : []), worker],
    intervalHours,
  }
}

const DEFAULT_DEPENDENCIES: DaemonCommandDependencies = {
  load: loadConfigStrict,
  start: (definition) => startDaemon(definition),
  stop: () => stopDaemon(),
  status: (intervalHours) => getSchedulerStatus(intervalHours),
  launchDefinition: defaultLaunchDefinition,
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
  setExitCode: (value) => {
    process.exitCode = value
  },
}

function commandFailure(operation: string, code: string, category: 'configuration' | 'internal') {
  return {
    operation,
    state: 'failure',
    category,
    issues: [
      {
        code,
        category,
        message: 'Scheduler command could not complete safely',
        nextAction: 'Validate configuration and inspect scheduler status',
      },
    ],
  }
}

export function registerDaemonCommand(
  program: Command,
  overrides: Partial<DaemonCommandDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const daemon = program.command('daemon').description('Manage persistent scheduled backups')

  daemon
    .command('start')
    .description('Install and activate the persistent backup schedule')
    .action(async () => {
      let phase: 'configuration' | 'internal' = 'configuration'
      try {
        const config = dependencies.load()
        phase = 'internal'
        if (config.daemon.intervalHours === 0) {
          const launchAgent = await dependencies.stop()
          const result = {
            operation: 'scheduler-start',
            state: 'success',
            category: 'success',
            enabled: false,
            intervalHours: 0,
            launchAgent,
            issues: [],
          }
          dependencies.writeStdout(JSON.stringify(result))
          dependencies.setExitCode(0)
          return
        }
        const launchAgent = await dependencies.start(
          dependencies.launchDefinition(config.daemon.intervalHours),
        )
        const result = {
          operation: 'scheduler-start',
          state: 'success',
          category: 'success',
          enabled: true,
          intervalHours: config.daemon.intervalHours,
          launchAgent,
          issues: [],
        }
        dependencies.writeStdout(JSON.stringify(result))
        dependencies.setExitCode(0)
      } catch {
        const result = commandFailure('scheduler-start', 'SCHEDULER_START_FAILED', phase)
        dependencies.writeStderr('daemon start: SCHEDULER_START_FAILED')
        dependencies.writeStdout(JSON.stringify(result))
        dependencies.setExitCode(EXIT_CODES[phase])
      }
    })

  daemon
    .command('stop')
    .description('Unload and remove the persistent backup schedule')
    .action(async () => {
      try {
        const launchAgent = await dependencies.stop()
        dependencies.writeStdout(
          JSON.stringify({
            operation: 'scheduler-stop',
            state: 'success',
            category: 'success',
            enabled: false,
            launchAgent,
            issues: [],
          }),
        )
        dependencies.setExitCode(0)
      } catch {
        const result = commandFailure('scheduler-stop', 'SCHEDULER_STOP_FAILED', 'internal')
        dependencies.writeStderr('daemon stop: SCHEDULER_STOP_FAILED')
        dependencies.writeStdout(JSON.stringify(result))
        dependencies.setExitCode(EXIT_CODES.internal)
      }
    })

  daemon
    .command('status')
    .description('Show the persistent scheduler and RPO status')
    .action(async () => {
      let phase: 'configuration' | 'internal' = 'configuration'
      try {
        const config = dependencies.load()
        phase = 'internal'
        const result = await dependencies.status(config.daemon.intervalHours)
        if (result.issues.length > 0) {
          dependencies.writeStderr(`daemon status: ${result.issues[0]?.code}`)
        }
        dependencies.writeStdout(JSON.stringify(result))
        dependencies.setExitCode(EXIT_CODES[result.category])
      } catch {
        const result = commandFailure('scheduler-status', 'SCHEDULER_STATUS_FAILED', phase)
        dependencies.writeStderr('daemon status: SCHEDULER_STATUS_FAILED')
        dependencies.writeStdout(JSON.stringify(result))
        dependencies.setExitCode(EXIT_CODES[phase])
      }
    })
}

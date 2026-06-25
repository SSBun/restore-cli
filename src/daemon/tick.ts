import { loadConfig as loadConfigDefault } from '../config/loader.js'
import type { Config } from '../config/types.js'
import { executeBackup as executeBackupDefault } from '../engine/run-backup.js'
import { error as errorDefault, info as infoDefault } from '../util/log.js'

interface BackupResult {
  snapshotName: string
}

interface DaemonTickDependencies {
  loadConfig?: () => Config
  executeBackup?: (config: Config) => Promise<BackupResult>
  info?: (message: string) => void
  error?: (message: string) => void
}

export function createDaemonTick(deps: DaemonTickDependencies = {}): () => Promise<void> {
  const loadConfig = deps.loadConfig ?? loadConfigDefault
  const executeBackup = deps.executeBackup ?? executeBackupDefault
  const info = deps.info ?? infoDefault
  const error = deps.error ?? errorDefault
  let running = false

  return async function tick(): Promise<void> {
    if (running) {
      info('Daemon backup skipped: previous backup is already running')
      return
    }

    running = true
    try {
      info(`Daemon backup starting (${new Date().toISOString()})`)
      const config = loadConfig()
      const { snapshotName } = await executeBackup(config)
      info(`Daemon backup complete: ${snapshotName}`)
    } catch (err) {
      error(`Daemon backup failed: ${(err as Error).message}`)
    } finally {
      running = false
    }
  }
}

import { runScheduledBackup } from '../scheduler/run.js'
import type { ScheduledBackupDependencies } from '../scheduler/run.js'
import type { SchedulerRunRecord } from '../scheduler/types.js'

export function createDaemonTick(
  dependencies: Partial<ScheduledBackupDependencies> = {},
): () => Promise<SchedulerRunRecord> {
  let active: Promise<SchedulerRunRecord> | undefined
  return async function tick(): Promise<SchedulerRunRecord> {
    if (active) return active
    active = runScheduledBackup(dependencies)
    try {
      return await active
    } finally {
      active = undefined
    }
  }
}

import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { loadConfig } from '../config/loader.js'
import { executeBackup } from '../engine/run-backup.js'
import { error, info } from '../util/log.js'

const PID_PATH = resolve(homedir(), '.config', 'restore', 'restore.pid')

writeFileSync(PID_PATH, String(process.pid), 'utf-8')

const intervalMs = Number(process.env.RESTORE_INTERVAL) || 12 * 60 * 60 * 1000

async function tick(): Promise<void> {
  try {
    info(`Daemon backup starting (${new Date().toISOString()})`)
    const config = loadConfig()
    const { snapshotName } = await executeBackup(config)
    info(`Daemon backup complete: ${snapshotName}`)
  } catch (err) {
    error(`Daemon backup failed: ${(err as Error).message}`)
  }
}

tick()
const interval = setInterval(tick, intervalMs)

process.on('SIGTERM', () => {
  clearInterval(interval)
  try {
    unlinkSync(PID_PATH)
  } catch {
    // ignore
  }
  process.exit(0)
})

process.on('SIGINT', () => process.exit(0))

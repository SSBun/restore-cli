import { unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const PID_PATH = resolve(homedir(), '.config', 'restore', 'restore.pid')

writeFileSync(PID_PATH, String(process.pid), 'utf-8')

const intervalMs = Number(process.env.RESTORE_INTERVAL) || 12 * 60 * 60 * 1000

async function tick(): Promise<void> {
  try {
    process.stdout.write(`[${new Date().toISOString()}] Daemon tick\n`)
  } catch (err) {
    process.stderr.write(`Daemon error: ${(err as Error).message}\n`)
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

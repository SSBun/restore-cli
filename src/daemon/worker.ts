import { removePidFile, writePidFile } from './lifecycle.js'
import { createDaemonTick } from './tick.js'

writePidFile()

const intervalMs = Number(process.env.RESTORE_INTERVAL) || 12 * 60 * 60 * 1000
const tick = createDaemonTick()

tick()
const interval = setInterval(tick, intervalMs)

process.on('SIGTERM', () => {
  clearInterval(interval)
  removePidFile()
  process.exit(0)
})

process.on('SIGINT', () => process.exit(0))

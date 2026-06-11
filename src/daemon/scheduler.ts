import { fork } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { error, info } from '../util/log.js'
import { readPid, removePidFile } from './lifecycle.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export function startDaemon(intervalMs: number): void {
  const child = fork(resolve(__dirname, '../../dist/daemon/worker.js'), [], {
    stdio: 'pipe',
    detached: true,
    env: { ...process.env, RESTORE_DAEMON: '1', RESTORE_INTERVAL: String(intervalMs) },
  })

  child.unref()

  child.on('spawn', () => {
    info(`Daemon started (PID: ${child.pid}), interval: ${intervalMs / 1000 / 3600}h`)
  })

  child.on('error', (err) => {
    error(`Failed to start daemon: ${err.message}`)
    process.exit(1)
  })
}

export function stopDaemon(): void {
  const pid = readPid()
  if (!pid) {
    info('Daemon is not running')
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
    removePidFile()
    info(`Sent SIGTERM to daemon (PID: ${pid})`)
  } catch {
    error(`Failed to stop daemon (PID: ${pid})`)
  }
}

import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { error, info } from '../util/log.js'
import { readPid, removePidFile } from './lifecycle.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function forkDaemonWorker(intervalMs: number) {
  const env = {
    ...process.env,
    RESTORE_DAEMON: '1',
    RESTORE_INTERVAL: String(intervalMs),
  }

  const workerJs = resolve(__dirname, 'worker.js')
  if (existsSync(workerJs)) {
    return fork(workerJs, [], { stdio: 'pipe', detached: true, env })
  }

  const workerTs = resolve(__dirname, 'worker.ts')
  return fork(workerTs, [], {
    execArgv: [...process.execArgv, '--import', 'tsx'],
    stdio: 'pipe',
    detached: true,
    env,
  })
}

export function startDaemon(intervalMs: number): void {
  const child = forkDaemonWorker(intervalMs)

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

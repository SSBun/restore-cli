import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { isDaemonRunning } from '../daemon/lifecycle.js'
import { startDaemon, stopDaemon } from '../daemon/scheduler.js'
import { info } from '../util/log.js'

export function registerDaemonCommand(program: Command): void {
  const daemonCmd = program.command('daemon').description('Manage the background backup daemon')

  daemonCmd
    .command('start')
    .description('Start the backup daemon')
    .action(async () => {
      if (isDaemonRunning()) {
        info('Daemon is already running')
        return
      }
      const config = loadConfig()
      if (config.daemon.intervalHours === 0) {
        info('Daemon is disabled because daemon.intervalHours is 0; not starting')
        return
      }
      const intervalMs = config.daemon.intervalHours * 60 * 60 * 1000
      startDaemon(intervalMs)
    })

  daemonCmd
    .command('stop')
    .description('Stop the backup daemon')
    .action(async () => {
      stopDaemon()
    })

  daemonCmd
    .command('status')
    .description('Check if daemon is running')
    .action(async () => {
      if (isDaemonRunning()) {
        info('Daemon is running')
      } else {
        info('Daemon is not running')
      }
    })
}

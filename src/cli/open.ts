import { spawn } from 'node:child_process'
import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import type { Config } from '../config/types.js'
import { error, info } from '../util/log.js'
import { getBackupRoot } from '../util/path.js'

export function registerOpenCommand(program: Command): void {
  program
    .command('open')
    .description('Open the local sync destination folder in Finder')
    .action(async () => {
      let config: Config
      try {
        config = loadConfig()
      } catch {
        error('No configuration found. Run `restore-cli config` first.')
        process.exitCode = 1
        return
      }
      const target = getBackupRoot(config.destination.path)
      spawn('open', [target], { stdio: 'inherit' }).on('error', () => {
        error(`Failed to open: ${target}`)
        process.exitCode = 1
      })
      info(`Opening ${target}`)
    })
}

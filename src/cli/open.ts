import { spawn } from 'node:child_process'
import type { Command } from 'commander'
import { loadConfigStrict } from '../config/loader.js'
import { error, info } from '../util/log.js'
import { expandPath } from '../util/path.js'

export function registerOpenCommand(program: Command): void {
  program
    .command('open')
    .description('Open the configured sync storage in Finder')
    .action(() => {
      try {
        const target = expandPath(loadConfigStrict().destination.path)
        spawn('open', [target], { stdio: 'inherit' }).on('error', () => {
          error(`Failed to open: ${target}`)
          process.exitCode = 1
        })
        info(`Opening ${target}`)
      } catch (failure) {
        error(failure instanceof Error ? failure.message : 'Mirror configuration is unavailable')
        process.exitCode = 1
      }
    })
}

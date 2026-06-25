#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { registerBackupCommand } from './cli/backup.js'
import { registerConfigCommand } from './cli/config.js'
import { registerDaemonCommand } from './cli/daemon.js'
import { registerRestoreCommand } from './cli/restore.js'
import { registerStatusCommand } from './cli/status.js'
import { registerToolCommand } from './cli/tool.js'
import { configExists } from './config/loader.js'
import { runWizard } from './config/wizard.js'
import { setQuiet, setVerbose } from './util/log.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'))

const program = new Command()

program
  .name('restore-cli')
  .description('Backup important files to cloud/local destinations')
  .version(pkg.version)
  .option('--verbose', 'enable debug output')
  .option('--quiet', 'suppress output except errors')

program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals()
  if (opts.verbose) setVerbose(true)
  if (opts.quiet) setQuiet(true)
})

// Register subcommands
registerConfigCommand(program)
registerBackupCommand(program)
registerRestoreCommand(program)
registerToolCommand(program)
registerDaemonCommand(program)
registerStatusCommand(program)

// First-run: auto-launch config wizard if no config exists
const noConfig = !configExists()
const args = process.argv.slice(2)
const isHelp = args.includes('--help') || args.includes('-h')
const isVersion = args.includes('--version') || args.includes('-V')
const isTool = args[0] === 'tool'

if (noConfig && !isHelp && !isVersion && !isTool) {
  console.log('No configuration found. Starting setup wizard...\n')
  await runWizard()
}

await program.parseAsync(process.argv)

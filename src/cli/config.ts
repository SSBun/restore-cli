import type { Command } from 'commander'
import { getConfigPath, loadConfig, validateConfigFile } from '../config/loader.js'
import { runWizard } from '../config/wizard.js'
import { error, info } from '../util/log.js'

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command('config').description('Manage restore configuration')

  configCmd.description('Run interactive setup wizard').action(async () => {
    await runWizard()
  })

  configCmd
    .command('show')
    .description('Print the current configuration')
    .action(() => {
      info(JSON.stringify(loadConfig(), null, 2))
    })

  configCmd
    .command('path')
    .description('Print the configuration file path')
    .action(() => {
      info(getConfigPath())
    })

  configCmd
    .command('validate')
    .description('Validate the configuration file')
    .action(() => {
      const result = validateConfigFile()
      if (result.ok) {
        info('Config is valid')
        return
      }

      error(`Config is invalid: ${result.error}`)
      process.exitCode = 1
    })
}

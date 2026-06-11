import type { Command } from 'commander'
import { runWizard } from '../config/wizard.js'

export function registerConfigCommand(program: Command): void {
  program
    .command('config')
    .description('Run interactive setup wizard')
    .action(async () => {
      await runWizard()
    })
}

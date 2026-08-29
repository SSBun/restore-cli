import type { Command } from 'commander'
import { Command as Commander } from 'commander'
import { configExists as configExistsDefault } from '../config/loader.js'
import { runWizard as runWizardDefault } from '../config/wizard.js'
import { setQuiet, setVerbose } from '../util/log.js'
import { serializeCliResult } from '../util/result.js'
import { registerBackupCommand } from './backup.js'
import { registerConfigCommand } from './config.js'
import { registerOpenCommand } from './open.js'
import { checkSupportedPlatform } from './platform.js'
import type { PlatformCheckResult } from './platform.js'
import { registerRestoreCommand } from './restore.js'
import { registerStatusCommand } from './status.js'

export interface ProgramDependencies {
  platform(): PlatformCheckResult
  configExists(): boolean
  runWizard(): Promise<unknown>
  interactive(): boolean
  writeStdout(value: string): void
  writeStderr(value: string): void
  setExitCode(value: number): void
}

const DEFAULT_DEPENDENCIES: ProgramDependencies = {
  platform: () => checkSupportedPlatform(),
  configExists: configExistsDefault,
  runWizard: runWizardDefault,
  interactive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
  setExitCode: (value) => {
    process.exitCode = value
  },
}

export function createProgram(version: string): Command {
  const program = new Commander()
    .name('restore-cli')
    .description('Synchronize and restore one readable copy of selected files')
    .version(version)
    .option('--json', 'emit one machine-readable JSON final result')
    .option('--non-interactive', 'never prompt; require destructive choices explicitly')
    .option('--verbose', 'enable debug output on stderr')
    .option('--quiet', 'suppress non-result informational output')

  program.hook('preAction', (command) => {
    const options = command.optsWithGlobals()
    if (options.verbose) setVerbose(true)
    if (options.quiet) setQuiet(true)
  })

  registerConfigCommand(program)
  registerBackupCommand(program)
  registerStatusCommand(program)
  registerRestoreCommand(program)
  registerOpenCommand(program)
  return program
}

function failure(code: string, message: string, nextAction: string) {
  return {
    operation: 'cli',
    state: 'failure',
    category: 'configuration',
    issues: [{ code, category: 'configuration', message, nextAction }],
    nextAction,
  }
}

function informational(args: readonly string[]): boolean {
  return args.some((argument) => ['--help', '-h', '--version', '-V'].includes(argument))
}

export async function runCli(
  argv: readonly string[],
  version: string,
  overrides: Partial<ProgramDependencies> = {},
): Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const args = argv.slice(2)
  const json = args.includes('--json')
  if (!informational(args)) {
    const platform = dependencies.platform()
    if (platform.state === 'failure') {
      dependencies.writeStderr(
        `platform-check: ${platform.issues[0]?.code ?? 'UNSUPPORTED_PLATFORM'}`,
      )
      dependencies.writeStdout(serializeCliResult(platform, json))
      dependencies.setExitCode(16)
      return
    }
  }

  const noCommand = args.length === 0 || args.every((argument) => argument.startsWith('-'))
  if (!dependencies.configExists() && noCommand && !informational(args)) {
    if (args.includes('--non-interactive') || !dependencies.interactive()) {
      const result = failure(
        'CONFIGURATION_REQUIRED',
        'Restore configuration is not initialized',
        'Run restore-cli config in an interactive terminal',
      )
      dependencies.writeStderr('configuration: CONFIGURATION_REQUIRED')
      dependencies.writeStdout(serializeCliResult(result, json))
      dependencies.setExitCode(10)
      return
    }
    await dependencies.runWizard()
    return
  }

  const program = createProgram(version)
  await program.parseAsync([...argv])
}

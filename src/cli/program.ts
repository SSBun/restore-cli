import type { Command } from 'commander'
import { Command as Commander } from 'commander'
import { configExists as configExistsDefault } from '../config/loader.js'
import { runWizard as runWizardDefault } from '../config/wizard.js'
import { setQuiet, setVerbose } from '../util/log.js'
import { serializeCliResult } from '../util/result.js'
import { registerV1ApplyCommands } from './apply.js'
import { registerBackupCommand } from './backup.js'
import { registerConfigCommand } from './config.js'
import { registerDaemonCommand } from './daemon.js'
import { registerDumpCommand } from './dump.js'
import { registerOpenCommand } from './open.js'
import { registerMigrateCommand } from './migrate.js'
import { checkSupportedPlatform } from './platform.js'
import type { PlatformCheckResult } from './platform.js'
import { registerRecoverCommand } from './recover.js'
import { registerRepositoryCommand } from './repository.js'
import { registerRestoreCommand, registerV1RestoreCommand } from './restore.js'
import { registerStatusCommand } from './status.js'
import { registerToolCommand } from './tool.js'
import { registerVerifyCommand } from './verify.js'

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
    .description('Verified configuration backup and recovery for Apple Silicon Macs')
    .version(version)
    .option('--json', 'emit one machine-readable JSON final result')
    .option('--non-interactive', 'never prompt; require every risky choice explicitly')
    .option('--verbose', 'enable debug output on stderr')
    .option('--quiet', 'suppress non-result informational output')

  program.hook('preAction', (thisCommand) => {
    const options = thisCommand.optsWithGlobals()
    if (options.verbose) setVerbose(true)
    if (options.quiet) setQuiet(true)
  })

  registerConfigCommand(program)
  registerRepositoryCommand(program)
  registerBackupCommand(program)
  registerVerifyCommand(program)
  registerV1RestoreCommand(program)
  registerV1ApplyCommands(program)
  registerMigrateCommand(program)
  registerRecoverCommand(program)
  registerDaemonCommand(program)
  registerStatusCommand(program)
  registerRestoreCommand(program)
  registerOpenCommand(program)
  registerDumpCommand(program)
  registerToolCommand(program)
  return program
}

function configurationRequiredResult() {
  return {
    operation: 'configuration',
    state: 'failure',
    category: 'configuration',
    issues: [
      {
        code: 'CONFIGURATION_REQUIRED',
        category: 'configuration',
        message: 'Restore configuration is not initialized and prompting is disabled',
        nextAction: 'Run restore-cli in an interactive terminal to initialize configuration',
      },
    ],
    nextAction: 'Run restore-cli in an interactive terminal to initialize configuration',
  }
}

function nonInteractiveResult() {
  return {
    operation: 'cli',
    state: 'failure',
    category: 'configuration',
    issues: [
      {
        code: 'NON_INTERACTIVE_INPUT_REQUIRED',
        category: 'configuration',
        message: 'This invocation requires interactive input and was refused',
        nextAction:
          'Provide every required selector and explicit dry-run or use an interactive terminal',
      },
    ],
    nextAction:
      'Provide every required selector and explicit dry-run or use an interactive terminal',
  }
}

function violatesNonInteractiveContract(args: readonly string[]): boolean {
  if (!args.includes('--non-interactive')) return false
  const positional = args.filter((argument) => !argument.startsWith('-'))
  const command = positional[0]
  if (command === 'tool') return true
  if (command === 'config') {
    const subcommand = positional[1]
    return subcommand !== 'show' && subcommand !== 'path' && subcommand !== 'validate'
  }
  if (command === 'legacy-restore') {
    return !args.includes('--snapshot') || !args.includes('--dry-run')
  }
  return false
}

function informationalInvocation(args: readonly string[]): boolean {
  return (
    args.includes('--help') ||
    args.includes('-h') ||
    args.includes('--version') ||
    args.includes('-V')
  )
}

export async function runCli(
  argv: readonly string[],
  version: string,
  overrides: Partial<ProgramDependencies> = {},
): Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const args = argv.slice(2)
  const json = args.includes('--json')
  if (!informationalInvocation(args)) {
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

  if (violatesNonInteractiveContract(args)) {
    const result = nonInteractiveResult()
    dependencies.writeStderr('cli: NON_INTERACTIVE_INPUT_REQUIRED')
    dependencies.writeStdout(serializeCliResult(result, json))
    dependencies.setExitCode(10)
    return
  }

  const noCommand = args.length === 0 || args.every((argument) => argument.startsWith('-'))
  if (!dependencies.configExists() && noCommand && !informationalInvocation(args)) {
    if (args.includes('--non-interactive') || !dependencies.interactive()) {
      const result = configurationRequiredResult()
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

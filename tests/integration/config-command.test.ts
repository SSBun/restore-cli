import { Command } from 'commander'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerConfigCommand } from '../../src/cli/config.js'

vi.mock('../../src/config/loader.js', () => ({
  getConfigPath: () => '/tmp/restore/config.json5',
  loadConfig: () => ({
    destination: { name: 'local', path: '/tmp/restore', type: 'local' },
    plugins: ['vscode'],
  }),
  validateConfigFile: vi.fn(() => ({ ok: true })),
}))

vi.mock('../../src/config/wizard.js', () => ({
  runWizard: vi.fn(),
}))

function createProgram(output: string[]): Command {
  const program = new Command()
  program.exitOverride()
  program.configureOutput({
    writeOut: (text) => output.push(text),
    writeErr: (text) => output.push(text),
  })
  registerConfigCommand(program)
  return program
}

describe('config command', () => {
  beforeEach(() => {
    process.exitCode = undefined
  })

  it('prints the config path without starting the wizard', async () => {
    const output: string[] = []
    const consoleLog = vi
      .spyOn(console, 'log')
      .mockImplementation((message) => output.push(message))
    const program = createProgram(output)

    try {
      await program.parseAsync(['node', 'test', 'config', 'path'])
    } finally {
      consoleLog.mockRestore()
    }

    expect(output.join('')).toContain('/tmp/restore/config.json5')
  })

  it('prints the current config', async () => {
    const output: string[] = []
    const consoleLog = vi
      .spyOn(console, 'log')
      .mockImplementation((message) => output.push(message))
    const program = createProgram(output)

    try {
      await program.parseAsync(['node', 'test', 'config', 'show'])
    } finally {
      consoleLog.mockRestore()
    }

    expect(output.join('')).toContain('"local"')
    expect(output.join('')).toContain('"vscode"')
    expect(output.join('')).not.toContain('intervalHours')
  })

  it('validates the current config', async () => {
    const output: string[] = []
    const consoleLog = vi
      .spyOn(console, 'log')
      .mockImplementation((message) => output.push(message))
    const program = createProgram(output)

    try {
      await program.parseAsync(['node', 'test', 'config', 'validate'])
    } finally {
      consoleLog.mockRestore()
    }

    expect(output.join('')).toContain('Config is valid')
    expect(process.exitCode).toBeUndefined()
  })
})

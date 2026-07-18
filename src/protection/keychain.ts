import { spawn } from 'node:child_process'
import type { CredentialProvider } from './credentials.js'
import { ProtectionAuthenticationError, ProtectionError } from './errors.js'
import { MasterKey } from './secrets.js'

const KEYCHAIN_SERVICE = 'com.ssbun.restore-cli.master-key.v1'
const MAX_SECURITY_OUTPUT_BYTES = 64 * 1024
export const SECURITY_EXECUTABLE = '/usr/bin/security'

export type SecurityCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  input?: Buffer,
) => Promise<Buffer>

export const runSecurityCommand: SecurityCommandRunner = (executable, arguments_, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    let outputLength = 0
    let failed = false

    child.stdout.on('data', (chunk: Buffer) => {
      outputLength += chunk.length
      if (outputLength > MAX_SECURITY_OUTPUT_BYTES) {
        failed = true
        child.kill()
        return
      }
      stdout.push(chunk)
    })
    child.stderr.resume()
    child.on('error', () =>
      reject(new ProtectionError('KEYCHAIN_FAILED', 'Keychain operation failed')),
    )
    child.on('close', (code) => {
      if (code !== 0 || failed) {
        reject(new ProtectionError('KEYCHAIN_FAILED', 'Keychain operation failed'))
        return
      }
      resolve(Buffer.concat(stdout))
    })

    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })

function validateRepositoryId(repositoryId: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(repositoryId)
  ) {
    throw new ProtectionError('INVALID_REPOSITORY_ID', 'Repository identity is invalid')
  }
}

export class MacOsKeychainCredentialProvider implements CredentialProvider {
  readonly #runner: SecurityCommandRunner

  constructor(runner: SecurityCommandRunner = runSecurityCommand) {
    this.#runner = runner
  }

  async storeMasterKey(repositoryId: string, masterKey: MasterKey): Promise<void> {
    validateRepositoryId(repositoryId)
    const secretBytes = masterKey.copyBytes()
    const input = Buffer.from(`${secretBytes.toString('base64')}\n`, 'utf8')
    secretBytes.fill(0)

    try {
      await this.#runner(
        SECURITY_EXECUTABLE,
        ['add-generic-password', '-a', repositoryId, '-s', KEYCHAIN_SERVICE, '-U', '-w'],
        input,
      )
    } finally {
      input.fill(0)
    }
  }

  async loadMasterKey(repositoryId: string): Promise<MasterKey> {
    validateRepositoryId(repositoryId)
    let output: Buffer
    try {
      output = await this.#runner(SECURITY_EXECUTABLE, [
        'find-generic-password',
        '-a',
        repositoryId,
        '-s',
        KEYCHAIN_SERVICE,
        '-w',
      ])
    } catch {
      throw new ProtectionAuthenticationError()
    }

    try {
      const encoded = output.toString('utf8').trim()
      if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('invalid key')
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length !== 32 || bytes.toString('base64') !== encoded)
        throw new Error('invalid key')
      return new MasterKey(bytes)
    } catch {
      throw new ProtectionAuthenticationError()
    } finally {
      output.fill(0)
    }
  }

  async deleteMasterKey(repositoryId: string): Promise<void> {
    validateRepositoryId(repositoryId)
    await this.#runner(SECURITY_EXECUTABLE, [
      'delete-generic-password',
      '-a',
      repositoryId,
      '-s',
      KEYCHAIN_SERVICE,
    ])
  }
}

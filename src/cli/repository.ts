import { lstat, realpath, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { Command } from 'commander'
import { MacOsKeychainCredentialProvider, ProtectionError } from '../protection/index.js'
import {
  RepositoryError,
  getRepositoryPath,
  initializeRepository,
  openRepository,
} from '../repository/index.js'
import {
  readBoundedRegularFile,
  syncDirectory,
  writeDurableExclusiveFile,
} from '../repository/io.js'

interface InitializeCommandOptions {
  plaintext?: boolean
  recoveryFile?: string
  requiredBytes: string
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child))
  return (
    pathFromParent === '' || (!pathFromParent.startsWith('..') && !pathFromParent.startsWith('/'))
  )
}

export interface PreparedRecoveryCredentialExport {
  canonicalPath: string
  exportCredential(material: string): Promise<Buffer>
  cleanup(): Promise<void>
}

export async function prepareRecoveryCredentialExport(
  requestedPath: string,
  repositoryPath: string,
): Promise<PreparedRecoveryCredentialExport> {
  let canonicalParent: string
  let canonicalRepositoryParent: string
  try {
    canonicalParent = await realpath(dirname(resolve(requestedPath)))
    canonicalRepositoryParent = await realpath(dirname(resolve(repositoryPath)))
  } catch {
    throw new RepositoryError(
      'configuration',
      'RECOVERY_EXPORT_PARENT_INVALID',
      'Recovery credential parent must already exist and resolve outside RestoreBackup',
    )
  }

  const canonicalPath = join(canonicalParent, basename(resolve(requestedPath)))
  const canonicalRepositoryPath = join(canonicalRepositoryParent, basename(resolve(repositoryPath)))
  if (isWithin(canonicalRepositoryPath, canonicalPath)) {
    throw new RepositoryError(
      'configuration',
      'RECOVERY_FILE_INSIDE_REPOSITORY',
      'Recovery credential must be stored outside RestoreBackup',
    )
  }

  let parentStat: Awaited<ReturnType<typeof stat>>
  try {
    parentStat = await stat(canonicalParent, { bigint: true })
  } catch {
    throw new RepositoryError(
      'configuration',
      'RECOVERY_EXPORT_PARENT_INVALID',
      'Recovery credential parent could not be inspected',
    )
  }
  let created = false
  let createdIdentity: { device: bigint; inode: bigint } | undefined
  async function removeCreatedFile(): Promise<void> {
    if (!created) return
    if (!createdIdentity) {
      throw new RepositoryError(
        'destination',
        'RECOVERY_EXPORT_CLEANUP_REFUSED',
        'Recovery credential identity is unknown; cleanup was refused',
      )
    }
    const current = await lstat(canonicalPath, { bigint: true })
    if (
      !current.isFile() ||
      current.dev !== createdIdentity.device ||
      current.ino !== createdIdentity.inode
    ) {
      throw new RepositoryError(
        'destination',
        'RECOVERY_EXPORT_CLEANUP_REFUSED',
        'Recovery credential path changed; the replacement was not removed',
      )
    }
    await unlink(canonicalPath)
    await syncDirectory(canonicalParent)
    created = false
    createdIdentity = undefined
  }

  return {
    canonicalPath,
    async exportCredential(material) {
      try {
        const currentParent = await stat(canonicalParent, { bigint: true })
        if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino) {
          throw new Error('parent identity changed')
        }
        await writeDurableExclusiveFile(canonicalPath, material)
        created = true
        const createdStat = await lstat(canonicalPath, { bigint: true })
        if (!createdStat.isFile()) throw new Error('export is not regular')
        createdIdentity = { device: createdStat.dev, inode: createdStat.ino }
        await syncDirectory(canonicalParent)

        const actualPath = await realpath(canonicalPath)
        if (actualPath !== canonicalPath || isWithin(canonicalRepositoryPath, actualPath)) {
          throw new Error('export escaped')
        }
        return await readBoundedRegularFile(canonicalPath, 1024)
      } catch {
        if (created) {
          await removeCreatedFile().catch(() => {})
        }
        throw new RepositoryError(
          'destination',
          'RECOVERY_EXPORT_FAILED',
          'Recovery credential could not be durably written and verified',
        )
      }
    },
    async cleanup() {
      await removeCreatedFile()
    },
  }
}

function exitCode(error: unknown): number {
  if (error instanceof RepositoryError) {
    return {
      authentication: 11,
      configuration: 10,
      destination: 14,
      integrity: 15,
      lock: 12,
    }[error.category]
  }
  if (error instanceof ProtectionError) return 11
  return 20
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof RepositoryError || error instanceof ProtectionError) return error.message
  return 'Repository command failed'
}

function parseRequiredBytes(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new RepositoryError(
      'configuration',
      'INVALID_REQUIRED_BYTES',
      'Required bytes must be a non-negative integer',
    )
  }
  return BigInt(value)
}

export function registerRepositoryCommand(program: Command): void {
  const repository = program.command('repository').description('Manage a RestoreBackup repository')

  repository
    .command('init')
    .description('Initialize a versioned repository under an existing target directory')
    .argument('<destination>', 'existing target directory')
    .option('--plaintext', 'create an explicitly unencrypted repository')
    .option('--recovery-file <path>', 'new file for the independent recovery credential')
    .option('--required-bytes <bytes>', 'minimum available capacity required', '0')
    .action(async (destination: string, options: InitializeCommandOptions) => {
      const protection = options.plaintext ? 'plaintext' : 'encrypted'
      let preparedRecoveryExport: PreparedRecoveryCredentialExport | undefined
      let initialized = false

      try {
        if (protection === 'encrypted' && !options.recoveryFile) {
          throw new RepositoryError(
            'configuration',
            'RECOVERY_FILE_REQUIRED',
            'Encrypted initialization requires --recovery-file outside RestoreBackup',
          )
        }
        if (protection === 'plaintext' && options.recoveryFile) {
          throw new RepositoryError(
            'configuration',
            'RECOVERY_FILE_NOT_APPLICABLE',
            'A plaintext repository does not use a recovery credential',
          )
        }

        let canonicalDestination: string
        try {
          canonicalDestination = await realpath(destination)
        } catch {
          throw new RepositoryError(
            'destination',
            'TARGET_MISSING',
            'Target directory does not exist; Restore will not create it',
          )
        }
        const repositoryPath = getRepositoryPath(canonicalDestination)
        const requiredBytes = parseRequiredBytes(options.requiredBytes)
        if (options.recoveryFile)
          preparedRecoveryExport = await prepareRecoveryCredentialExport(
            options.recoveryFile,
            repositoryPath,
          )

        const result = await initializeRepository({
          targetPath: canonicalDestination,
          protection,
          requiredBytes,
          credentialProvider:
            protection === 'encrypted' ? new MacOsKeychainCredentialProvider() : undefined,
          exportRecoveryCredential: preparedRecoveryExport?.exportCredential,
        })
        initialized = true
        console.log(
          JSON.stringify({
            operation: 'repository-init',
            state: 'success',
            repositoryId: result.repositoryId,
            repositoryPath: result.repositoryPath,
            protection: result.protection,
            targetIdentity: result.targetIdentity,
            availableBytes: result.availableBytes,
            requiredBytes: requiredBytes.toString(),
            recoveryCredentialExported: result.recoveryCredentialExported,
          }),
        )
      } catch (error) {
        if (preparedRecoveryExport && !initialized) {
          try {
            await preparedRecoveryExport.cleanup()
          } catch {}
        }
        console.error(safeErrorMessage(error))
        process.exitCode = exitCode(error)
      }
    })

  repository
    .command('inspect')
    .description('Validate repository identity and target capabilities without writing')
    .argument('<repository-path>', 'path ending in RestoreBackup')
    .requiredOption('--repository-id <id>', 'expected repository identity')
    .requiredOption('--protection <mode>', 'expected protection mode: encrypted or plaintext')
    .action(
      async (repositoryPath: string, options: { repositoryId: string; protection: string }) => {
        try {
          if (options.protection !== 'encrypted' && options.protection !== 'plaintext') {
            throw new RepositoryError(
              'configuration',
              'INVALID_PROTECTION_MODE',
              'Protection mode must be encrypted or plaintext',
            )
          }
          const handle = await openRepository(repositoryPath, {
            intent: 'read',
            expectedRepositoryId: options.repositoryId,
            expectedProtection: options.protection,
          })
          console.log(
            JSON.stringify({
              operation: 'repository-inspect',
              state: 'success',
              repositoryId: handle.descriptor.repositoryId,
              repositoryPath: handle.path,
              protection: handle.descriptor.protection,
              availableBytes: handle.preflight.availableBytes.toString(),
            }),
          )
        } catch (error) {
          console.error(safeErrorMessage(error))
          process.exitCode = exitCode(error)
        }
      },
    )
}

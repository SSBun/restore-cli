import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import type { Config } from '../config/types.js'
import { MacOsKeychainCredentialProvider } from '../protection/index.js'
import { resolvePoint } from '../recovery/index.js'
import { readDirectoryBoundFile, safeRelativePath } from '../recovery/safe-io.js'
import { color } from '../util/color.js'
import { error, info } from '../util/log.js'
import { getBackupRoot } from '../util/path.js'
import { MAX_PROTECTED_BLOB_BYTES } from '../verify/index.js'

export function registerDumpCommand(program: Command): void {
  program
    .command('dump')
    .description('Extract backup contents as plaintext files to a directory')
    .option('--output <dir>', 'target directory for extracted files', './restore-dump')
    .option('--point <id>', 'recovery point ID (defaults to latest healthy)')
    .action(async (options: { output: string; point?: string }) => {
      let config: Config
      try {
        config = loadConfig()
      } catch {
        error('No configuration found. Run `restore-cli config` first.')
        process.exitCode = 1
        return
      }
      if (!config.repository) {
        error('No repository configured. Run `restore-cli config` first.')
        process.exitCode = 1
        return
      }
      const repositoryPath = getBackupRoot(config.destination.path)
      try {
        const loaded = await resolvePoint({
          repositoryPath,
          expectedRepositoryId: config.repository.id,
          expectedProtection: config.repository.protection,
          ...(config.repository.protection === 'encrypted'
            ? { credentialProvider: new MacOsKeychainCredentialProvider() }
            : {}),
          ...(options.point ? { pointId: options.point } : {}),
        })
        const { repository, point, manifest } = loaded
        const outputDir = options.output
        const sourceMap = new Map(manifest.sources.map((s) => [s.id, s]))
        const blobMap = new Map(manifest.blobs.map((b) => [b.id, b]))
        let filesWritten = 0
        for (const entry of manifest.entries) {
          if (entry.type === 'directory') {
            const source = sourceMap.get(entry.sourceId)
            if (!source) continue
            const dir = entryDest(outputDir, source.plugin, source.name, entry.relativePath)
            await mkdir(dir, { recursive: true })
          }
        }
        for (const entry of manifest.entries) {
          if (entry.type !== 'file') continue
          const source = sourceMap.get(entry.sourceId)
          if (!source) continue
          const dest = entryDest(outputDir, source.plugin, source.name, entry.relativePath)
          const blob = entry.blobId ? blobMap.get(entry.blobId) : undefined
          if (!blob || !repository.protector) continue
          const protectedContent = await readDirectoryBoundFile(
            join(point.path, 'blobs'),
            blob.path.split('/').pop() ?? blob.path,
            MAX_PROTECTED_BLOB_BYTES,
          )
          const plaintext = await repository.protector.open(protectedContent, {
            repositoryId: repository.descriptor.repositoryId,
            purpose: 'blob',
            objectId: blob.id,
          })
          await mkdir(dirname(dest), { recursive: true })
          await writeFile(dest, plaintext)
          filesWritten++
          protectedContent.fill(0)
          plaintext.fill(0)
        }
        repository.close()
        info(`${color.green('\u2713')} Dumped ${filesWritten} files to ${color.bold(outputDir)}`)
        info(`${color.dim(`Point: ${point.id}`)}`)
      } catch (err) {
        error(`Dump failed: ${(err as Error).message}`)
        process.exitCode = 1
      }
    })
}

function entryDest(
  outputDir: string,
  plugin: string,
  sourceName: string,
  relativePath: string,
): string {
  if (relativePath === '.') return join(outputDir, plugin, sourceName)
  return join(outputDir, plugin, sourceName, safeRelativePath(relativePath))
}

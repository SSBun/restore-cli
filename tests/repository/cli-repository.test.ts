import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareRecoveryCredentialExport } from '../../src/cli/repository.js'
import { getRepositoryPath, initializeRepository } from '../../src/repository/index.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('recovery credential file export', () => {
  it('uses a canonical existing parent, durable exclusive creation, readback, and cleanup', async () => {
    const target = await temporaryDirectory('restore-cli-target-')
    const exportParent = await temporaryDirectory('restore-cli-export-')
    const aliasRoot = await temporaryDirectory('restore-cli-alias-')
    const alias = join(aliasRoot, 'export-link')
    await symlink(exportParent, alias)

    const prepared = await prepareRecoveryCredentialExport(
      join(alias, 'recovery.txt'),
      getRepositoryPath(target),
    )
    expect(prepared.canonicalPath).toBe(join(await realpath(exportParent), 'recovery.txt'))
    const material = 'restore-recovery-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    await expect(prepared.exportCredential(material)).resolves.toEqual(Buffer.from(material))
    await expect(readFile(prepared.canonicalPath, 'utf8')).resolves.toBe(material)
    expect((await lstat(prepared.canonicalPath)).isSymbolicLink()).toBe(false)

    await prepared.cleanup()
    await expect(lstat(prepared.canonicalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects direct, existing-alias, future-alias, and dangling parents', async () => {
    const target = await temporaryDirectory('restore-cli-contained-')
    const initialized = await initializeRepository({ targetPath: target, protection: 'plaintext' })
    await expect(
      prepareRecoveryCredentialExport(
        join(initialized.repositoryPath, 'recovery.txt'),
        initialized.repositoryPath,
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_FILE_INSIDE_REPOSITORY' })

    const aliases = await temporaryDirectory('restore-cli-contained-alias-')
    const existingAlias = join(aliases, 'existing')
    await symlink(initialized.repositoryPath, existingAlias)
    await expect(
      prepareRecoveryCredentialExport(
        join(existingAlias, 'recovery.txt'),
        initialized.repositoryPath,
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_FILE_INSIDE_REPOSITORY' })

    const futureTarget = await temporaryDirectory('restore-cli-future-')
    const futureAlias = join(aliases, 'future')
    await symlink(getRepositoryPath(futureTarget), futureAlias)
    await expect(
      prepareRecoveryCredentialExport(
        join(futureAlias, 'recovery.txt'),
        getRepositoryPath(futureTarget),
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_EXPORT_PARENT_INVALID' })

    await expect(
      prepareRecoveryCredentialExport(
        join(aliases, 'missing-parent', 'recovery.txt'),
        getRepositoryPath(futureTarget),
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_EXPORT_PARENT_INVALID' })
  })

  it('does not follow an existing final symlink', async () => {
    const target = await temporaryDirectory('restore-cli-nofollow-target-')
    const exportParent = await temporaryDirectory('restore-cli-nofollow-export-')
    const outside = join(exportParent, 'outside')
    await writeFile(outside, 'unchanged')
    const prepared = await prepareRecoveryCredentialExport(
      join(exportParent, 'recovery.txt'),
      getRepositoryPath(target),
    )
    await symlink(outside, prepared.canonicalPath)

    await expect(
      prepared.exportCredential('restore-recovery-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ).rejects.toMatchObject({ code: 'RECOVERY_EXPORT_FAILED' })
    await expect(readFile(outside, 'utf8')).resolves.toBe('unchanged')
  })
})

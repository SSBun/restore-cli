import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_OPERATION_HISTORY_ENTRIES,
  MAX_OPERATION_PENDING_ENTRIES,
  RepositoryError,
  createMacOsStableIdentityResolver,
  createOperationResult,
  getRepositoryPath,
  initializeRepository,
  listOperationResults,
  openRepository,
  preflightTarget,
  recordOperationResult,
  targetIdentityMatches,
} from '../../src/repository/index.js'

const temporaryDirectories: string[] = []

async function createTarget(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'restore-repository-'))
  temporaryDirectories.push(target)
  return target
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('repository initialization and open', () => {
  it('allows device reassignment but keeps stable ID, filesystem, and mount path exact', () => {
    const identity = {
      deviceId: '1',
      fileSystemType: '2',
      mountPath: '/Volumes/Backup',
      stableIdentity: 'volume:00000000-0000-4000-8000-000000000001',
    }
    expect(targetIdentityMatches(identity, { ...identity })).toBe(true)
    expect(
      targetIdentityMatches(identity, { ...identity, mountPath: '/Volumes/Other/../Backup' }),
    ).toBe(true)
    expect(targetIdentityMatches(identity, { ...identity, deviceId: 'changed' })).toBe(true)
    expect(targetIdentityMatches(identity, { ...identity, fileSystemType: 'changed' })).toBe(false)
    expect(targetIdentityMatches(identity, { ...identity, mountPath: '/Volumes/Other' })).toBe(
      false,
    )
    expect(
      targetIdentityMatches(identity, {
        ...identity,
        stableIdentity: 'volume:00000000-0000-4000-8000-000000000002',
      }),
    ).toBe(false)
  })

  it('persists a stable identity and rejects a replacement before the write probe', async () => {
    const target = await createTarget()
    const originalStableIdentity = 'volume:00000000-0000-4000-8000-000000000011'
    const replacementStableIdentity = 'volume:00000000-0000-4000-8000-000000000012'
    const initialized = await initializeRepository({
      targetPath: target,
      protection: 'plaintext',
      stableIdentityResolver: async () => originalStableIdentity,
    })
    expect(initialized.targetIdentity.stableIdentity).toBe(originalStableIdentity)

    const before = await lstat(initialized.repositoryPath, { bigint: true })
    await expect(
      openRepository(initialized.repositoryPath, {
        intent: 'write',
        expectedRepositoryId: initialized.repositoryId,
        expectedProtection: 'plaintext',
        stableIdentityResolver: async () => replacementStableIdentity,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_IDENTITY_MISMATCH' })
    const after = await lstat(initialized.repositoryPath, { bigint: true })
    expect(after.mtimeNs).toBe(before.mtimeNs)
  })

  it('canonicalizes credential-bearing network sources before hashing', async () => {
    const stableIdentityFor = async (source: string, fileSystemType = 'smbfs') => {
      const resolver = createMacOsStableIdentityResolver(async (executable) => {
        expect(executable.startsWith('/')).toBe(true)
        if (executable === '/sbin/mount') {
          return Buffer.from(`${source} on /Volumes/Backup (${fileSystemType}, nodev, nosuid)\n`)
        }
        throw new Error('local identity commands must not run for a remote mount')
      })
      return resolver({
        resolvedPath: '/Volumes/Backup',
        mountPath: '/Volumes/Backup',
        deviceId: '123',
        fileSystemType,
      })
    }

    const passwordDictionary = ['secret', 'password', 'summer2026', '123456']
    const uncGuesses = await Promise.all(
      passwordDictionary.map((password) =>
        stableIdentityFor(`//alice:${password}@example.invalid/backup`),
      ),
    )
    expect(new Set(uncGuesses)).toHaveLength(1)
    expect(await stableIdentityFor('smb://bob:first@example.invalid:445/backup')).toBe(
      await stableIdentityFor('smb://carol:second@example.invalid:445/backup'),
    )
    expect(await stableIdentityFor('alice@example.invalid:/exports/backup', 'nfs')).toBe(
      await stableIdentityFor('bob@example.invalid:/exports/backup', 'nfs'),
    )

    const stableIdentity = uncGuesses[0]
    expect(stableIdentity).toMatch(/^network-sha256:[0-9a-f]{64}$/)
    expect(stableIdentity).not.toContain('alice')
    expect(stableIdentity).not.toContain('secret')
    expect(await stableIdentityFor('//alice:secret@other.invalid/backup')).not.toBe(stableIdentity)
    expect(await stableIdentityFor('//alice:secret@example.invalid/other')).not.toBe(stableIdentity)
  })

  it('fails preflight when no stable identity can be established', async () => {
    const target = await createTarget()
    await expect(
      preflightTarget(target, {
        intent: 'read',
        stableIdentityResolver: async () => {
          throw new Error('injected resolver failure')
        },
      }),
    ).rejects.toMatchObject({ code: 'TARGET_INSPECTION_FAILED' })
  })

  it('creates the explicit v1 layout and requires the configured repository identity', async () => {
    const target = await createTarget()
    const initialized = await initializeRepository({ targetPath: target, protection: 'plaintext' })

    expect(initialized.repositoryPath).toBe(getRepositoryPath(await realpath(target)))
    expect(initialized.protection).toBe('plaintext')
    await expect(lstat(join(initialized.repositoryPath, 'repository.json'))).resolves.toBeDefined()
    await expect(lstat(join(initialized.repositoryPath, 'keys'))).resolves.toBeDefined()
    await expect(lstat(join(initialized.repositoryPath, 'points'))).resolves.toBeDefined()
    await expect(lstat(join(initialized.repositoryPath, 'locks'))).resolves.toBeDefined()
    await expect(lstat(join(initialized.repositoryPath, 'operations'))).resolves.toBeDefined()

    const opened = await openRepository(initialized.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: initialized.repositoryId,
      expectedProtection: 'plaintext',
    })
    expect(opened.descriptor.repositoryId).toBe(initialized.repositoryId)

    await expect(
      openRepository(initialized.repositoryPath, {
        intent: 'read',
        expectedRepositoryId: '00000000-0000-4000-8000-000000000000',
        expectedProtection: 'plaintext',
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_IDENTITY_MISMATCH' })
    await expect(
      openRepository(initialized.repositoryPath, {
        intent: 'read',
        expectedRepositoryId: initialized.repositoryId,
        expectedProtection: 'encrypted',
      }),
    ).rejects.toMatchObject({ code: 'PROTECTION_MODE_MISMATCH' })
  })

  it('rejects every changed target identity field before a write capability probe', async () => {
    const target = await createTarget()
    const initialized = await initializeRepository({ targetPath: target, protection: 'plaintext' })
    const descriptorPath = join(initialized.repositoryPath, 'repository.json')
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
    for (const [field, changed] of [
      ['fileSystemType', `${descriptor.targetIdentity.fileSystemType}-changed`],
      ['mountPath', '/different-mount'],
      ['stableIdentity', 'volume:00000000-0000-4000-8000-000000000099'],
    ]) {
      const mutated = structuredClone(descriptor)
      mutated.targetIdentity[field] = changed
      await writeFile(descriptorPath, JSON.stringify(mutated))
      await expect(
        openRepository(initialized.repositoryPath, {
          intent: 'write',
          expectedRepositoryId: initialized.repositoryId,
          expectedProtection: 'plaintext',
        }),
      ).rejects.toMatchObject({ code: 'TARGET_IDENTITY_MISMATCH' })
    }
  })

  it('never creates a missing repository during normal open', async () => {
    const target = await createTarget()
    const repositoryPath = getRepositoryPath(target)

    await expect(
      openRepository(repositoryPath, {
        intent: 'read',
        expectedRepositoryId: '00000000-0000-4000-8000-000000000000',
        expectedProtection: 'plaintext',
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_MISSING' })
    await expect(lstat(repositoryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not take over an occupied RestoreBackup path', async () => {
    const target = await createTarget()
    const repositoryPath = getRepositoryPath(target)
    await mkdir(repositoryPath)
    const foreignFile = join(repositoryPath, 'keep-me')
    await writeFile(foreignFile, 'foreign data')

    await expect(
      initializeRepository({ targetPath: target, protection: 'plaintext' }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_PATH_OCCUPIED' })
    await expect(readFile(foreignFile, 'utf8')).resolves.toBe('foreign data')
  })

  it('fails missing, non-directory, insufficient-space, and portable read-only preflights', async () => {
    const target = await createTarget()
    await expect(
      preflightTarget(join(target, 'missing'), { intent: 'write' }),
    ).rejects.toMatchObject({ code: 'TARGET_MISSING' })

    const file = join(target, 'file')
    await writeFile(file, 'data')
    await expect(preflightTarget(file, { intent: 'write' })).rejects.toMatchObject({
      code: 'TARGET_NOT_DIRECTORY',
    })

    await expect(
      preflightTarget(target, { intent: 'write', requiredBytes: 1n << 100n }),
    ).rejects.toMatchObject({ code: 'TARGET_SPACE_INSUFFICIENT' })

    if (process.getuid?.() !== 0) {
      await chmod(target, 0o500)
      try {
        await expect(preflightTarget(target, { intent: 'write' })).rejects.toMatchObject({
          code: 'TARGET_CAPABILITY_FAILED',
        })
      } finally {
        await chmod(target, 0o700)
      }
    }
  })
})

describe('operation history', () => {
  it('records only the explicit result surface and enforces a bound', async () => {
    const target = await createTarget()
    const initialized = await initializeRepository({ targetPath: target, protection: 'plaintext' })
    const repository = await openRepository(initialized.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: initialized.repositoryId,
      expectedProtection: 'plaintext',
    })

    for (let index = 0; index < 3; index++) {
      const result = createOperationResult({
        operation: `test-${index}`,
        state: 'success',
        category: 'success',
        repositoryId: initialized.repositoryId,
        startedAt: `2026-07-18T00:00:0${index}.000Z`,
        endedAt: `2026-07-18T00:00:0${index}.000Z`,
      })
      await recordOperationResult(repository, result, 2)
    }

    const history = await listOperationResults(repository)
    expect(history).toHaveLength(2)
    expect(history.map((entry) => entry.operation)).toEqual(['test-2', 'test-1'])
  })

  it('fails closed when the operations parent is replaced by a symlink', async () => {
    const target = await createTarget()
    const outside = await createTarget()
    const initialized = await initializeRepository({ targetPath: target, protection: 'plaintext' })
    const repository = await openRepository(initialized.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: initialized.repositoryId,
      expectedProtection: 'plaintext',
    })
    await rm(repository.layout.operations, { recursive: true })
    await symlink(outside, repository.layout.operations)
    const result = createOperationResult({
      operation: 'symlink-parent',
      state: 'success',
      category: 'success',
      repositoryId: initialized.repositoryId,
      startedAt: '2026-07-18T00:00:00.000Z',
      endedAt: '2026-07-18T00:00:01.000Z',
    })

    await expect(recordOperationResult(repository, result)).rejects.toMatchObject({
      code: 'INVALID_OPERATION_HISTORY',
    })
    await expect(listOperationResults(repository)).rejects.toMatchObject({
      code: 'INVALID_OPERATION_HISTORY',
    })
    expect(await readdir(outside)).toEqual([])
  })

  it('caps on-disk fan-out and rejects maxEntries above the product limit', async () => {
    const target = await createTarget()
    const initialized = await initializeRepository({ targetPath: target, protection: 'plaintext' })
    const repository = await openRepository(initialized.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: initialized.repositoryId,
      expectedProtection: 'plaintext',
    })
    const result = createOperationResult({
      operation: 'bounded-history',
      state: 'success',
      category: 'success',
      repositoryId: initialized.repositoryId,
      startedAt: '2026-07-18T00:00:00.000Z',
      endedAt: '2026-07-18T00:00:01.000Z',
    })

    await expect(
      recordOperationResult(repository, result, MAX_OPERATION_HISTORY_ENTRIES + 1),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY_LIMIT' })
    expect(await readdir(repository.layout.operations)).toEqual([])

    await Promise.all(
      Array.from({ length: MAX_OPERATION_HISTORY_ENTRIES + 1 }, (_, index) =>
        writeFile(
          join(repository.layout.operations, `${String(index).padStart(4, '0')}.json`),
          '{}',
        ),
      ),
    )
    await expect(listOperationResults(repository)).rejects.toMatchObject({
      code: 'OPERATION_HISTORY_LIMIT_EXCEEDED',
    })
  })

  it('ignores bounded crash-pending history and removes it on the next authenticated record', async () => {
    const target = await createTarget()
    const initialized = await initializeRepository({ targetPath: target, protection: 'plaintext' })
    const repository = await openRepository(initialized.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: initialized.repositoryId,
      expectedProtection: 'plaintext',
    })
    const first = createOperationResult({
      operation: 'first',
      state: 'success',
      category: 'success',
      repositoryId: initialized.repositoryId,
      startedAt: '2026-07-18T00:00:00.000Z',
      endedAt: '2026-07-18T00:00:01.000Z',
    })
    await recordOperationResult(repository, first)
    const crashPending = join(
      repository.layout.operations,
      `2026-07-18T00-00-02.000Z-crash-${randomUUID()}.json.pending`,
    )
    await writeFile(crashPending, '{ incomplete')

    await expect(listOperationResults(repository)).resolves.toHaveLength(1)
    const second = createOperationResult({
      ...first,
      operation: 'second',
      startedAt: '2026-07-18T00:00:02.000Z',
      endedAt: '2026-07-18T00:00:03.000Z',
    })
    await recordOperationResult(repository, second)
    expect(
      (await readdir(repository.layout.operations)).some((entry) => entry.endsWith('.pending')),
    ).toBe(false)
    await expect(listOperationResults(repository)).resolves.toHaveLength(2)

    const unknownPending = join(repository.layout.operations, 'unknown.json.pending')
    await writeFile(unknownPending, 'do not remove')
    await expect(recordOperationResult(repository, second)).rejects.toMatchObject({
      code: 'INVALID_OPERATION_HISTORY',
    })
    await expect(readFile(unknownPending, 'utf8')).resolves.toBe('do not remove')
  })

  it('fails promptly when crash-pending history exceeds its explicit cap', async () => {
    const target = await createTarget()
    const initialized = await initializeRepository({ targetPath: target, protection: 'plaintext' })
    const repository = await openRepository(initialized.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: initialized.repositoryId,
      expectedProtection: 'plaintext',
    })
    await Promise.all(
      Array.from({ length: MAX_OPERATION_PENDING_ENTRIES + 1 }, (_, index) =>
        writeFile(
          join(
            repository.layout.operations,
            `2026-07-18T00-00-${String(index).padStart(2, '0')}.000Z-crash-${randomUUID()}.json.pending`,
          ),
          '{ incomplete',
        ),
      ),
    )

    await expect(listOperationResults(repository)).rejects.toMatchObject({
      code: 'OPERATION_HISTORY_PENDING_LIMIT_EXCEEDED',
    })
  })
})

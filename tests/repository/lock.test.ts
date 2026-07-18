import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as waitForRetry } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RepositoryLockError,
  acquireRepositoryLock,
  clearConfirmedRepositoryLock,
  clearOrphanedRepositoryLock,
  clearStaleRepositoryLock,
  initializeRepository,
  inspectRepositoryLock,
  openRepository,
} from '../../src/repository/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function writableRepository() {
  const target = await mkdtemp(join(tmpdir(), 'restore-lock-'))
  temporaryDirectories.push(target)
  const initialized = await initializeRepository({ targetPath: target, protection: 'plaintext' })
  const repository = await openRepository(initialized.repositoryPath, {
    intent: 'write',
    expectedRepositoryId: initialized.repositoryId,
    expectedProtection: 'plaintext',
  })
  return { initialized, repository }
}

async function writeStaleLock(
  repository: Awaited<ReturnType<typeof writableRepository>>['repository'],
  lockId: string,
): Promise<void> {
  await mkdir(repository.layout.repositoryLock)
  await writeFile(
    join(repository.layout.repositoryLock, 'owner.json'),
    JSON.stringify({
      formatVersion: 1,
      lockId,
      owner: { pid: 999_999, hostname: hostname(), instanceId: 'dead-owner' },
      operation: 'backup',
      startedAt: '2000-01-01T00:00:00.000Z',
    }),
  )
}

describe('repository lock', () => {
  it('allows one owner and reports live contention without clearing it', async () => {
    const { repository } = await writableRepository()
    const first = await acquireRepositoryLock(repository, 'backup', { instanceId: 'first' })

    await expect(
      acquireRepositoryLock(repository, 'backup', { instanceId: 'second' }),
    ).rejects.toMatchObject({
      code: 'REPOSITORY_LOCKED',
      inspection: {
        state: 'locked',
        metadata: { operation: 'backup', owner: { instanceId: 'first' } },
      },
    })
    await expect(
      clearStaleRepositoryLock(repository, first.metadata.lockId, {
        now: new Date('2030-01-01T00:00:00.000Z'),
        staleAfterMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'LOCK_NOT_PROVEN_STALE' })
    expect(await inspectRepositoryLock(repository)).toMatchObject({ state: 'locked' })

    await first.release()
    await first.release()
    expect(await inspectRepositoryLock(repository)).toEqual({ state: 'unlocked' })
  })

  it('quarantines stale cleanup so two clearers never delete a successor', async () => {
    const { repository } = await writableRepository()
    const staleLockId = '00000000-0000-4000-8000-000000000001'
    await writeStaleLock(repository, staleLockId)

    const clearOptions = {
      now: new Date('2026-07-18T00:00:00.000Z'),
      staleAfterMs: 1,
    }
    const clearers = [
      clearStaleRepositoryLock(repository, staleLockId, clearOptions),
      clearStaleRepositoryLock(repository, staleLockId, clearOptions),
    ]
    const successorPromise = (async () => {
      for (let attempt = 0; attempt < 500; attempt++) {
        try {
          return await acquireRepositoryLock(repository, 'successor', {
            instanceId: 'successor',
          })
        } catch (error) {
          if (
            !(error instanceof RepositoryLockError) &&
            !(error instanceof Error && 'code' in error && error.code === 'LOCK_ACQUIRE_FAILED')
          ) {
            throw error
          }
          await waitForRetry(2)
        }
      }
      throw new Error('successor never acquired')
    })()

    const [clearResults, successor] = await Promise.all([
      Promise.allSettled(clearers),
      successorPromise,
    ])
    expect(clearResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await inspectRepositoryLock(repository)).toMatchObject({
      state: 'locked',
      metadata: { lockId: successor.metadata.lockId, owner: { instanceId: 'successor' } },
    })
    await successor.release()
  })

  it('requires explicit orphan confirmation and never removes unknown entries', async () => {
    const { repository } = await writableRepository()
    await mkdir(repository.layout.repositoryLock)

    await expect(clearOrphanedRepositoryLock(repository, { confirm: false })).rejects.toMatchObject(
      { code: 'ORPHAN_LOCK_CONFIRMATION_REQUIRED' },
    )
    await writeFile(join(repository.layout.repositoryLock, 'unknown'), 'keep')
    await expect(clearOrphanedRepositoryLock(repository, { confirm: true })).rejects.toMatchObject({
      code: 'LOCK_HAS_UNKNOWN_ENTRIES',
    })
    await expect(readFile(join(repository.layout.repositoryLock, 'unknown'), 'utf8')).resolves.toBe(
      'keep',
    )

    await rm(repository.layout.repositoryLock, { recursive: true })
    await mkdir(repository.layout.repositoryLock)
    await clearOrphanedRepositoryLock(repository, { confirm: true })
    expect(await inspectRepositoryLock(repository)).toEqual({ state: 'unlocked' })

    await mkdir(repository.layout.repositoryLock)
    await writeFile(join(repository.layout.repositoryLock, 'owner.json'), '{ corrupt')
    await clearOrphanedRepositoryLock(repository, { confirm: true })
    expect(await inspectRepositoryLock(repository)).toEqual({ state: 'unlocked' })
  })

  it('clears a valid remote lock only with exact displayed confirmation', async () => {
    const { repository } = await writableRepository()
    const lockId = '00000000-0000-4000-8000-000000000044'
    const owner = { pid: 4242, hostname: 'remote.example.invalid', instanceId: 'remote-instance' }
    await mkdir(repository.layout.repositoryLock)
    await writeFile(
      join(repository.layout.repositoryLock, 'owner.json'),
      JSON.stringify({
        formatVersion: 1,
        lockId,
        owner,
        operation: 'remote-backup',
        startedAt: '2026-07-18T00:00:00.000Z',
      }),
    )

    const inspection = await inspectRepositoryLock(repository)
    expect(inspection).toMatchObject({ state: 'locked', ownerAlive: null, metadata: { lockId } })
    await expect(
      clearConfirmedRepositoryLock(repository, {
        confirm: false,
        expectedLockId: lockId,
        expectedOwner: owner,
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_LOCK_CONFIRMATION_REQUIRED' })
    await expect(
      clearConfirmedRepositoryLock(repository, {
        confirm: true,
        expectedLockId: '00000000-0000-4000-8000-000000000045',
        expectedOwner: owner,
      }),
    ).rejects.toMatchObject({ code: 'LOCK_CONFIRMATION_MISMATCH' })
    expect(await inspectRepositoryLock(repository)).toMatchObject({
      state: 'locked',
      metadata: { lockId },
    })

    await writeFile(join(repository.layout.repositoryLock, 'unknown'), 'keep')
    await expect(
      clearConfirmedRepositoryLock(repository, {
        confirm: true,
        expectedLockId: lockId,
        expectedOwner: owner,
      }),
    ).rejects.toMatchObject({ code: 'LOCK_HAS_UNKNOWN_ENTRIES' })
    await rm(join(repository.layout.repositoryLock, 'unknown'))

    await clearConfirmedRepositoryLock(repository, {
      confirm: true,
      expectedLockId: lockId,
      expectedOwner: owner,
    })
    expect(await inspectRepositoryLock(repository)).toEqual({ state: 'unlocked' })
  })
})

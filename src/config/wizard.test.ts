import { describe, expect, it, vi } from 'vitest'
import { initializePlaintextDestination } from './wizard.js'

describe('initializePlaintextDestination', () => {
  it('creates the destination and returns the initialized plaintext repository identity', async () => {
    const mkdir = vi.fn(async () => undefined)
    const initialize = vi.fn(async () => ({
      repositoryId: '00000000-0000-4000-8000-000000000001',
      repositoryPath: '/tmp/backup/RestoreBackup',
      createdAt: '2026-07-19T00:00:00.000Z',
      protection: 'plaintext' as const,
      targetIdentity: {
        deviceId: '1',
        fileSystemType: 'apfs',
        mountPath: '/tmp',
        stableIdentity: 'volume:00000000-0000-4000-8000-000000000001',
      },
      availableBytes: '1',
      recoveryCredentialExported: false,
    }))

    await expect(
      initializePlaintextDestination('/tmp/backup', { mkdir, initialize }),
    ).resolves.toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      protection: 'plaintext',
    })
    expect(mkdir).toHaveBeenCalledWith('/tmp/backup', { recursive: true, mode: 0o700 })
    expect(initialize).toHaveBeenCalledWith({
      targetPath: '/tmp/backup',
      protection: 'plaintext',
    })
  })

  it('does not return a configuration when repository initialization fails', async () => {
    const failure = new Error('initialization failed')

    await expect(
      initializePlaintextDestination('/tmp/backup', {
        mkdir: vi.fn(async () => undefined),
        initialize: vi.fn(async () => {
          throw failure
        }),
      }),
    ).rejects.toBe(failure)
  })
})

import { describe, expect, it, vi } from 'vitest'

describe('pruneSnapshotsDetailed', () => {
  it('reports prune failures without throwing', async () => {
    const rm = vi.fn(async () => {
      throw new Error('busy')
    })

    vi.resetModules()
    vi.doMock('node:fs/promises', () => ({
      copyFile: vi.fn(),
      link: vi.fn(),
      mkdir: vi.fn(),
      readdir: async () => [
        { name: '2026-01-01T00-00-00.000', isDirectory: () => true },
        { name: '2026-01-02T00-00-00.000', isDirectory: () => true },
      ],
      rm,
      stat: vi.fn(),
    }))

    const { pruneSnapshotsDetailed } = await import('./prune.js')

    await expect(pruneSnapshotsDetailed('/backup', 1)).resolves.toEqual({
      removed: 0,
      failed: ['2026-01-01T00-00-00.000'],
    })
    expect(rm).toHaveBeenCalledTimes(1)

    vi.doUnmock('node:fs/promises')
    vi.resetModules()
  })
})

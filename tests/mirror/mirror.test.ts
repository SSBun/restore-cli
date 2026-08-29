import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapturePlan } from '../../src/catalog/types.js'
import { inspectMirror, restoreMirror, synchronizeMirror } from '../../src/mirror/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  source: string
  mirror: string
  plan: CapturePlan
}> {
  const root = await mkdtemp(join(tmpdir(), 'restore-mirror-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'settings.txt'), 'original')
  const plugin = {
    name: 'test',
    description: 'test files',
    paths: [source],
    sources: [
      {
        name: 'files',
        path: source,
        requirement: 'required' as const,
        sensitivity: 'private' as const,
        expectedType: 'directory' as const,
        recoveryScope: 'exact',
      },
    ],
  }
  return {
    root,
    source,
    mirror: join(root, 'destination', 'RestoreBackup'),
    plan: {
      plugins: [plugin],
      sources: [
        {
          id: 'test:files',
          plugin: 'test',
          name: 'files',
          declaredPath: source,
          path: source,
          requirement: 'required',
          sensitivity: 'private',
          expectedType: 'directory',
          recoveryScope: 'exact',
          includeEmptyDirectories: true,
          exclude: [],
        },
      ],
    },
  }
}

describe('latest readable mirror', () => {
  it('publishes one strict mirror and restores create, modify, and delete differences', async () => {
    const value = await fixture()
    const dryRun = await synchronizeMirror({
      root: value.mirror,
      plan: value.plan,
      dryRun: true,
    })
    expect(dryRun.changed).toBe(false)
    expect(dryRun.diff.length).toBeGreaterThan(0)

    const backup = await synchronizeMirror({
      root: value.mirror,
      plan: value.plan,
      dryRun: false,
    })
    expect(backup.changed).toBe(true)
    expect(await readFile(join(value.mirror, 'test', 'files', 'settings.txt'), 'utf8')).toBe(
      'original',
    )

    await writeFile(join(value.source, 'settings.txt'), 'modified')
    await writeFile(join(value.source, 'local-only.txt'), 'delete me')
    const drift = await inspectMirror(value.mirror, value.plan)
    expect(new Set(drift.diff.map((entry) => entry.action))).toEqual(new Set(['modify', 'delete']))

    await restoreMirror(value.mirror, value.plan)
    expect(await readFile(join(value.source, 'settings.txt'), 'utf8')).toBe('original')
    await expect(readFile(join(value.source, 'local-only.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect((await inspectMirror(value.mirror, value.plan)).diff).toEqual([])
  })
})

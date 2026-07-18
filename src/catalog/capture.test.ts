import { execFile } from 'node:child_process'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest, SourceSpec } from '../plugin/types.js'
import { capturePlan } from './capture.js'
import { buildCapturePlan } from './scope.js'
import { CatalogCaptureError } from './stable-read.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'restore-catalog-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function plugin(source: Partial<SourceSpec> & Pick<SourceSpec, 'path'>): PluginManifest {
  const normalized: SourceSpec = {
    name: source.name ?? 'source',
    path: source.path,
    requirement: source.requirement ?? 'required',
    sensitivity: source.sensitivity ?? 'private',
    expectedType: source.expectedType ?? 'any',
    recoveryScope: source.recoveryScope ?? 'exact',
    ...(source.consistencyGroup ? { consistencyGroup: source.consistencyGroup } : {}),
    ...(source.includeEmptyDirectories === undefined
      ? {}
      : { includeEmptyDirectories: source.includeEmptyDirectories }),
  }
  return { name: 'test', description: 'test plugin', paths: [source.path], sources: [normalized] }
}

function namedPlugin(
  pluginName: string,
  source: Partial<SourceSpec> & Pick<SourceSpec, 'path'>,
): PluginManifest {
  const value = plugin(source)
  return { ...value, name: pluginName }
}

describe('catalog capture', () => {
  it('captures hidden directories and keeps symlinks as link objects without following them', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    const outside = join(root, 'outside')
    await mkdir(join(source, '.hidden'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(source, '.hidden', 'value'), 'hidden')
    await writeFile(join(outside, 'secret'), 'outside')
    await symlink(outside, join(source, 'outside-link'))

    const captured = await capturePlan(buildCapturePlan([plugin({ path: source })]))

    expect(captured.requiredFailed).toBe(false)
    expect(captured.entries.map((entry) => entry.relativePath)).toEqual([
      '.',
      '.hidden',
      '.hidden/value',
      'outside-link',
    ])
    const linkEntry = captured.entries.find((entry) => entry.relativePath === 'outside-link')
    expect(linkEntry).toMatchObject({ type: 'symlink', linkTarget: outside })
    expect(captured.entries.some((entry) => entry.relativePath.includes('secret'))).toBe(false)
  })

  it('captures a directly declared final symlink but rejects a symlink parent scope', async () => {
    const root = await temporaryRoot()
    const outside = join(root, 'outside')
    const direct = join(root, 'direct')
    await mkdir(outside)
    await writeFile(join(outside, 'value'), 'outside')
    await symlink(outside, direct)

    const directCapture = await capturePlan(
      buildCapturePlan([plugin({ path: direct, expectedType: 'symlink' })]),
    )
    expect(directCapture.entries).toHaveLength(1)
    expect(directCapture.entries[0]).toMatchObject({ type: 'symlink', linkTarget: outside })

    const parentAlias = join(root, 'parent-alias')
    await symlink(outside, parentAlias)
    expect(() =>
      buildCapturePlan([plugin({ path: join(parentAlias, 'value'), expectedType: 'file' })]),
    ).toThrowError(/symbolic-link parent/)
  })

  it('fails closed when a final regular file becomes a symlink during capture', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    const outside = join(root, 'outside')
    await writeFile(source, 'inside')
    await writeFile(outside, 'outside')
    let replaced = false

    const result = await capturePlan(
      buildCapturePlan([plugin({ path: source, expectedType: 'file' })]),
      {
        onReadAttempt: async () => {
          if (replaced) return
          replaced = true
          await unlink(source)
          await symlink(outside, source)
        },
      },
    )

    expect(result.requiredFailed).toBe(true)
    expect(result.sources[0]?.status).toBe('failed')
    expect(result.issues[0]?.code).toMatch(/SOURCE_(?:SYMLINK_ESCAPE|TYPE_CHANGED)/)
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside')
  })

  it('preserves hardlink relation and narrow portable metadata', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(source)
    const first = join(source, 'first')
    const second = join(source, 'second')
    await writeFile(first, 'same inode')
    await chmod(first, 0o640)
    await link(first, second)

    const metadataCommandRunner = async (executable: string, args: string[]) => {
      if (executable.endsWith('/xattr') && args.includes('-p')) return Buffer.from('76616c7565\n')
      if (executable.endsWith('/xattr')) return Buffer.from('user.restore-test\n')
      return Buffer.from('uchg,nodump\n')
    }
    const result = await capturePlan(buildCapturePlan([plugin({ path: source })]), {
      metadataCommandRunner,
    })
    const files = result.entries.filter((entry) => entry.type === 'file')

    expect(files).toHaveLength(2)
    expect(files[0]?.metadata.mode).toBe(0o640)
    expect(files[0]?.metadata.modifiedAtNs).toMatch(/^\d+$/)
    expect(files[0]?.metadata.xattrs).toEqual([
      { name: 'user.restore-test', value: Buffer.from('value').toString('base64') },
    ])
    expect(files[0]?.metadata.flags).toEqual(['nodump', 'uchg'])
    expect(files[1]?.hardlinkTo).toBe(files[0]?.id)
    expect(files[1]?.content).toBeUndefined()
  })

  it('includes empty directories only when the source policy requests them', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(join(source, 'empty'), { recursive: true })

    const omitted = await capturePlan(buildCapturePlan([plugin({ path: source })]))
    const included = await capturePlan(
      buildCapturePlan([plugin({ path: source, includeEmptyDirectories: true })]),
    )

    expect(omitted.entries.map((entry) => entry.relativePath)).toEqual(['.'])
    expect(included.entries.map((entry) => entry.relativePath)).toEqual(['.', 'empty'])
  })

  it('exhausts bounded retries instead of accepting a file mutated during each read', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'changing')
    await writeFile(source, '0000')
    let mutations = 0

    const result = await capturePlan(
      buildCapturePlan([plugin({ path: source, expectedType: 'file' })]),
      {
        attempts: 2,
        onReadAttempt: async () => {
          mutations++
          await writeFile(source, String(mutations).padStart(4, '0'))
        },
      },
    )

    expect(mutations).toBeGreaterThanOrEqual(2)
    expect(mutations).toBeLessThanOrEqual(4)
    expect(result.requiredFailed).toBe(true)
    expect(result.sources[0]).toMatchObject({ status: 'unstable' })
    expect(result.issues[0]?.code).toBe('SOURCE_UNSTABLE')
  })

  it('fails closed when a direct or nested parent is swapped before file open', async () => {
    for (const nested of [false, true]) {
      const root = await temporaryRoot()
      const parent = nested ? join(root, 'outer', 'parent') : join(root, 'parent')
      const outside = join(root, `outside-${nested}`)
      const moved = join(root, `moved-${nested}`)
      await mkdir(parent, { recursive: true })
      await mkdir(outside)
      await writeFile(join(parent, 'value'), 'inside')
      await writeFile(join(outside, 'value'), 'outside')
      let swapped = false

      const result = await capturePlan(
        buildCapturePlan([plugin({ path: join(parent, 'value'), expectedType: 'file' })]),
        {
          attempts: 1,
          async onBeforeFileOpen() {
            if (swapped) return
            swapped = true
            const target = nested ? join(root, 'outer') : parent
            await rename(target, moved)
            await symlink(outside, target)
          },
        },
      )

      expect(result.requiredFailed).toBe(true)
      expect(result.issues[0]?.code).toBe('SOURCE_SCOPE_CHANGED')
      expect(result.entries).toEqual([])
    }
  })

  it('marks metadata command failure and malformed xattrs as partial fidelity loss', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await writeFile(source, 'content')

    for (const malformed of [false, true]) {
      const result = await capturePlan(buildCapturePlan([plugin({ path: source })]), {
        metadataCommandRunner: async (executable, args) => {
          if (executable.endsWith('/stat')) return Buffer.from('-\n')
          if (!args.includes('-p')) return Buffer.from('user.restore-test\n')
          if (malformed) return Buffer.from('not-hex')
          throw new Error('permission denied')
        },
      })
      expect(result.requiredFailed).toBe(false)
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'METADATA_XATTR_UNREADABLE', severity: 'partial' }),
        ]),
      )
      expect(result.entries[0]?.fidelityIssues).toBeDefined()
    }

    const flagsFailure = await capturePlan(buildCapturePlan([plugin({ path: source })]), {
      metadataCommandRunner: async (executable) => {
        if (executable.endsWith('/xattr')) return Buffer.alloc(0)
        throw new Error('flags permission denied')
      },
    })
    expect(flagsFailure.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'METADATA_FLAGS_UNREADABLE', severity: 'partial' }),
      ]),
    )
  })

  it('uses macOS xattr symlink-object flags without the help flag', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'target')
    const source = join(root, 'source-link')
    await writeFile(target, 'target')
    await symlink(target, source)
    const calls: string[][] = []

    const plan = buildCapturePlan([plugin({ path: source, expectedType: 'symlink' })])
    const result = await capturePlan(plan, {
      metadataCommandRunner: async (executable, args) => {
        if (executable.endsWith('/xattr')) calls.push(args)
        if (executable.endsWith('/stat')) return Buffer.from('-\n')
        if (args.includes('-p')) return Buffer.from('76616c7565\n')
        return Buffer.from('user.restore-test\n')
      },
    })

    expect(result.issues).toEqual([])
    expect(calls).toEqual([
      ['-s', '--', plan.sources[0].path],
      ['-p', '-x', '-s', 'user.restore-test', '--', plan.sources[0].path],
    ])
    expect(calls.flat()).not.toContain('-h')
  })

  it('does not accept outside native metadata through a restored parent ABA', async () => {
    if (platform() !== 'darwin') return
    const root = await temporaryRoot()
    const parent = join(root, 'parent')
    const moved = join(root, 'parent-held')
    const outside = join(root, 'outside')
    await mkdir(parent)
    await mkdir(outside)
    const source = join(parent, 'value')
    const outsideSource = join(outside, 'value')
    await writeFile(source, 'same')
    await writeFile(outsideSource, 'same')
    await execFileAsync('/usr/bin/xattr', ['-w', 'user.restore-aba', 'inside', source])
    await execFileAsync('/usr/bin/xattr', ['-w', 'user.restore-aba', 'outside', outsideSource])
    let attacked = false
    let needsRestore = false

    const result = await capturePlan(buildCapturePlan([plugin({ path: source })]), {
      attempts: 1,
      async onBeforeMetadataCommand() {
        if (attacked) return
        attacked = true
        needsRestore = true
        await rename(parent, moved)
        await symlink(outside, parent)
      },
      async onAfterMetadataCommand() {
        if (!needsRestore) return
        needsRestore = false
        await unlink(parent)
        await rename(moved, parent)
      },
    })

    expect(result.issues.map((issue) => issue.code)).toContain('METADATA_XATTR_UNREADABLE')
    expect(result.entries[0]?.metadata.xattrs).toBeUndefined()
    expect(JSON.stringify(result.entries[0]?.metadata)).not.toContain(
      Buffer.from('outside').toString('base64'),
    )
  })

  it('rejects a consistency group that changes between sequential member captures', async () => {
    const root = await temporaryRoot()
    const first = join(root, 'first')
    const second = join(root, 'second')
    await writeFile(first, '0000')
    await writeFile(second, '0000')
    let generation = 0

    const result = await capturePlan(
      buildCapturePlan([
        namedPlugin('first-plugin', {
          path: first,
          requirement: 'optional',
          consistencyGroup: 'pair',
        }),
        namedPlugin('second-plugin', {
          path: second,
          requirement: 'optional',
          consistencyGroup: 'pair',
        }),
      ]),
      {
        attempts: 2,
        async onSourceCaptured(sourceId) {
          if (sourceId !== 'first-plugin:source') return
          generation++
          const value = String(generation).padStart(4, '0')
          await writeFile(first, value)
          await writeFile(second, value)
        },
      },
    )

    expect(result.requiredFailed).toBe(false)
    expect(result.consistencyGroupsFailed).toEqual(['pair'])
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CONSISTENCY_GROUP_UNSTABLE', severity: 'partial' }),
      ]),
    )
    expect(result.entries).toEqual([])
  })

  it('rejects same-content group ABA when inode, ctime, and topology change', async () => {
    const root = await temporaryRoot()
    const first = join(root, 'first')
    const second = join(root, 'second')
    await writeFile(first, 'same')
    await writeFile(second, 'same')
    let generation = 0

    const result = await capturePlan(
      buildCapturePlan([
        namedPlugin('first-plugin', {
          path: first,
          requirement: 'optional',
          consistencyGroup: 'identity-pair',
        }),
        namedPlugin('second-plugin', {
          path: second,
          requirement: 'optional',
          consistencyGroup: 'identity-pair',
        }),
      ]),
      {
        attempts: 2,
        async onSourceCaptured(sourceId) {
          if (sourceId !== 'first-plugin:source') return
          generation++
          for (const path of [first, second]) {
            const replacement = `${path}.replacement-${generation}`
            await writeFile(replacement, 'same')
            await rename(replacement, path)
          }
        },
      },
    )

    expect(result.consistencyGroupsFailed).toEqual(['identity-pair'])
    expect(result.issues.map((issue) => issue.code)).toContain('CONSISTENCY_GROUP_UNSTABLE')
    expect(result.entries).toEqual([])
  })

  it('reserves the total capture budget before reading an excess file', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(source)
    for (const name of ['a', 'b', 'c']) await writeFile(join(source, name), '1234')
    const reads: string[] = []

    const result = await capturePlan(buildCapturePlan([plugin({ path: source })]), {
      attempts: 1,
      maxTotalBytes: 8,
      onReadAttempt(path) {
        reads.push(path)
      },
    })

    expect(reads.map((path) => path.split('/').at(-1))).toEqual(['a', 'b'])
    expect(result.requiredFailed).toBe(true)
    expect(result.issues[0]?.code).toBe('CAPTURE_TOO_LARGE')
  })

  it('does not create hardlink relations across source recovery units', async () => {
    const root = await temporaryRoot()
    const firstRoot = join(root, 'first-source')
    const secondRoot = join(root, 'second-source')
    await mkdir(firstRoot)
    await mkdir(secondRoot)
    const first = join(firstRoot, 'value')
    const second = join(secondRoot, 'value')
    await writeFile(first, 'shared')
    await link(first, second)

    const result = await capturePlan(
      buildCapturePlan([
        namedPlugin('first-plugin', { path: firstRoot }),
        namedPlugin('second-plugin', { path: secondRoot }),
      ]),
    )
    const files = result.entries.filter((entry) => entry.type === 'file')

    expect(files).toHaveLength(2)
    expect(files.every((entry) => entry.hardlinkTo === undefined)).toBe(true)
    expect(files.every((entry) => entry.content?.toString() === 'shared')).toBe(true)
  })

  it('classifies optional source instability as partial after bounded retries', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'optional')
    await writeFile(source, 'value')
    let attempts = 0

    const result = await capturePlan(
      buildCapturePlan([plugin({ path: source, expectedType: 'file', requirement: 'optional' })]),
      {
        attempts: 2,
        async onBeforeFileOpen() {
          attempts++
          await rm(source, { force: true })
          await writeFile(source, String(attempts).padStart(5, '0'))
        },
      },
    )

    expect(attempts).toBe(2)
    expect(result.requiredFailed).toBe(false)
    expect(result.issues[0]).toMatchObject({ severity: 'partial' })
  })

  it('classifies optional final type change as partial', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'optional')
    const outside = join(root, 'outside')
    await writeFile(source, 'inside')
    await writeFile(outside, 'outside')
    let changed = false

    const result = await capturePlan(
      buildCapturePlan([plugin({ path: source, expectedType: 'file', requirement: 'optional' })]),
      {
        attempts: 1,
        async onBeforeFileOpen() {
          if (changed) return
          changed = true
          await rm(source)
          await symlink(outside, source)
        },
      },
    )

    expect(result.requiredFailed).toBe(false)
    expect(result.issues[0]).toMatchObject({ severity: 'partial' })
    expect(result.entries).toEqual([])
  })

  it('retries a transient unreadable optional source before accepting it', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'optional')
    await writeFile(source, 'content')
    let attempts = 0

    const result = await capturePlan(
      buildCapturePlan([plugin({ path: source, expectedType: 'file', requirement: 'optional' })]),
      {
        attempts: 2,
        onBeforeFileOpen() {
          attempts++
          if (attempts === 1) {
            throw new CatalogCaptureError('SOURCE_UNREADABLE', 'transient unreadable source')
          }
        },
      },
    )

    expect(attempts).toBe(2)
    expect(result.issues).toEqual([])
    expect(result.sources[0]?.status).toBe('captured')
  })
})

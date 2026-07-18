import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest } from '../plugin/types.js'
import { buildCapturePlan, displayCaptureScope } from './scope.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function manifest(name: string, path: string): PluginManifest {
  return {
    name,
    description: name,
    paths: [path],
    sources: [
      {
        name: 'source',
        path,
        requirement: 'optional',
        sensitivity: 'private',
        expectedType: 'any',
        recoveryScope: 'exact',
      },
    ],
  }
}

describe('source scope', () => {
  it('sorts display scope deterministically and rejects overlaps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restore-scope-'))
    roots.push(root)
    const one = join(root, 'one')
    const two = join(root, 'two')
    await writeFile(one, 'one')
    await mkdir(two)

    const plan = buildCapturePlan([manifest('z-plugin', two), manifest('a-plugin', one)])
    expect(displayCaptureScope(plan).map((line) => line.split('\t')[0])).toEqual([
      'a-plugin:source',
      'z-plugin:source',
    ])
    expect(() => buildCapturePlan([manifest('parent', root), manifest('child', one)])).toThrowError(
      /overlap/,
    )
  })

  it('rejects lexical escape, filesystem root, and incompatible entry type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restore-scope-'))
    roots.push(root)
    const file = join(root, 'file')
    await writeFile(file, 'file')

    expect(() => buildCapturePlan([manifest('escape', `${root}/../escape`)])).toThrowError(/\.\./)
    expect(() => buildCapturePlan([manifest('root', '/')])).toThrowError(/Filesystem root/)
    const wrong = manifest('wrong', file)
    if (wrong.sources) wrong.sources[0].expectedType = 'directory'
    expect(() => buildCapturePlan([wrong])).toThrowError(/expected type/)
  })

  it('rejects canonical aliases and source-to-repository ancestry', async () => {
    const root = await mkdtemp('/tmp/restore-scope-alias-')
    roots.push(root)
    const source = join(root, 'source')
    const repository = join(root, 'repository')
    await mkdir(source)
    await mkdir(repository)
    const privateAlias = root.replace(/^\/tmp\//, '/private/tmp/')

    expect(() =>
      buildCapturePlan([
        manifest('tmp-alias', source),
        manifest('private-alias', join(privateAlias, 'source')),
      ]),
    ).toThrowError(/overlap/)
    expect(() =>
      buildCapturePlan([manifest('repository-parent', root)], {
        forbiddenPaths: [repository],
      }),
    ).toThrowError(/repository scope/)
    expect(() =>
      buildCapturePlan([manifest('repository-child', join(repository, 'child'))], {
        forbiddenPaths: [repository],
      }),
    ).toThrowError(/repository scope/)
  })
})

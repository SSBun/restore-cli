import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCapturePlan, sourceContractFingerprint } from '../catalog/scope.js'
import type { PluginManifest } from '../plugin/types.js'
import { prunePlaintextSecretAcceptances, validateConfig } from './loader.js'
import { ConfigSchema } from './types.js'

const roots: string[] = []

async function userPluginDirectory(plugin: unknown): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'restore-config-validation-'))
  roots.push(root)
  const directory = join(root, 'plugins')
  await mkdir(directory)
  await writeFile(join(directory, 'plugin.json'), JSON.stringify(plugin))
  return { root, directory }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('config schema', () => {
  it('allows daemon interval 0 to disable background backups', () => {
    const config = ConfigSchema.parse({
      destination: { name: 'local', path: '/tmp/restore', type: 'local' },
      daemon: { intervalHours: 0 },
    })

    expect(config.daemon.intervalHours).toBe(0)
  })

  it('rejects unknown configuration fields', () => {
    expect(() =>
      ConfigSchema.parse({
        destination: { name: 'local', path: '/tmp/restore', type: 'local' },
        unknown: true,
      }),
    ).toThrow()
  })

  it('rejects unknown and duplicate enabled plugins', () => {
    const base = ConfigSchema.parse({
      destination: { name: 'local', path: '/tmp/restore', type: 'local' },
      plugins: ['not-installed'],
    })
    expect(() => validateConfig(base, { pluginDirectory: '/definitely/missing' })).toThrowError(
      /Unknown plugin/,
    )
    expect(() =>
      validateConfig(
        { ...base, plugins: ['git', 'git'] },
        { pluginDirectory: '/definitely/missing' },
      ),
    ).toThrowError(/more than once/)
  })

  it('rejects overlapping, dangerous, escaping, and incompatible source scopes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restore-config-sources-'))
    roots.push(root)
    const sourceRoot = join(root, 'source')
    const sourceFile = join(sourceRoot, 'file')
    await mkdir(sourceRoot)
    await writeFile(sourceFile, 'file')
    const source = (name: string, path: string, expectedType = 'any') => ({
      name,
      path,
      requirement: 'optional',
      sensitivity: 'private',
      expectedType,
      recoveryScope: 'exact',
    })
    const cases = [
      {
        expected: /overlap/,
        sources: [source('parent', sourceRoot), source('child', sourceFile)],
      },
      { expected: /Filesystem root/, sources: [source('root', '/')] },
      { expected: /\.\./, sources: [source('escape', `${sourceRoot}/../escape`)] },
      { expected: /expected type/, sources: [source('type', sourceFile, 'directory')] },
    ]

    for (const [index, testCase] of cases.entries()) {
      const { directory } = await userPluginDirectory({
        name: `custom-${index}`,
        description: 'custom',
        sources: testCase.sources,
      })
      const config = ConfigSchema.parse({
        destination: { name: 'local', path: root, type: 'local' },
        plugins: [`custom-${index}`],
      })
      expect(() => validateConfig(config, { pluginDirectory: directory })).toThrowError(
        testCase.expected,
      )
    }

    const repositorySource = join(root, 'RestoreBackup', 'inside')
    await mkdir(repositorySource, { recursive: true })
    const { directory } = await userPluginDirectory({
      name: 'repository-source',
      description: 'repository source',
      sources: [source('inside-repository', repositorySource)],
    })
    const repositoryConfig = ConfigSchema.parse({
      destination: { name: 'local', path: root, type: 'local' },
      plugins: ['repository-source'],
    })
    expect(() => validateConfig(repositoryConfig, { pluginDirectory: directory })).toThrowError(
      /repository scope/,
    )
  })

  it('requires a repository-scoped acceptance for every enabled plaintext secret source', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'restore-config-secret-'))
    roots.push(sourceRoot)
    const secretPath = join(sourceRoot, 'secret')
    await writeFile(secretPath, 'secret')
    const { directory } = await userPluginDirectory({
      name: 'secret-plugin',
      description: 'secret plugin',
      sources: [
        {
          name: 'credential',
          path: secretPath,
          requirement: 'required',
          expectedType: 'file',
          recoveryScope: 'exact',
        },
      ],
    })
    const repositoryId = '00000000-0000-4000-8000-000000000001'
    const config = ConfigSchema.parse({
      destination: { name: 'local', path: sourceRoot, type: 'local' },
      repository: { id: repositoryId, protection: 'plaintext' },
      plugins: ['secret-plugin'],
    })

    expect(() => validateConfig(config, { pluginDirectory: directory })).toThrowError(
      /independent acceptance/,
    )
    const sourceFingerprint = sourceContractFingerprint(
      buildCapturePlan([
        {
          name: 'secret-plugin',
          description: 'secret plugin',
          paths: [secretPath],
          sources: [
            {
              name: 'credential',
              path: secretPath,
              requirement: 'required',
              sensitivity: 'secret',
              expectedType: 'file',
              recoveryScope: 'exact',
            },
          ],
        } satisfies PluginManifest,
      ]).sources[0],
    )
    const acceptedConfig = {
      ...config,
      plaintextSecretAcceptances: [
        {
          repositoryId,
          sourceId: 'secret-plugin:credential',
          sourceContractFingerprint: sourceFingerprint,
          acceptedAt: '2026-07-19T00:00:00.000Z',
        },
      ],
    }
    expect(validateConfig(acceptedConfig, { pluginDirectory: directory })).toBeDefined()

    const disabled = { ...acceptedConfig, plugins: [] }
    expect(() => validateConfig(disabled, { pluginDirectory: directory })).toThrowError(
      /stale or orphaned/,
    )
    const savedDisabled = prunePlaintextSecretAcceptances(disabled, {
      pluginDirectory: directory,
    })
    expect(savedDisabled.plaintextSecretAcceptances).toEqual([])
    expect(validateConfig(savedDisabled, { pluginDirectory: directory })).toBeDefined()
    expect(() =>
      validateConfig(
        { ...savedDisabled, plugins: ['secret-plugin'] },
        { pluginDirectory: directory },
      ),
    ).toThrowError(/independent acceptance/)

    await writeFile(
      join(directory, 'plugin.json'),
      JSON.stringify({
        name: 'secret-plugin',
        description: 'secret plugin',
        sources: [
          {
            name: 'credential',
            path: secretPath,
            requirement: 'required',
            expectedType: 'file',
            recoveryScope: 'changed-contract',
          },
        ],
      }),
    )
    expect(() => validateConfig(acceptedConfig, { pluginDirectory: directory })).toThrowError(
      /independent acceptance/,
    )
  })
})

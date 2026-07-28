import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getEnabledPlugins, loadUserPlugins } from '../../src/plugin/loader.js'
import { getBuiltinPlugin, getPluginNames } from '../../src/plugin/registry.js'

const temporaryDirectories: string[] = []

async function pluginDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'restore-user-plugins-'))
  temporaryDirectories.push(root)
  const directory = join(root, 'plugins')
  await mkdir(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('plugin registry', () => {
  it('should list builtin plugins', () => {
    const names = getPluginNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain('restore-cli')
    expect(names).toContain('vscode')
    expect(names).not.toContain('dotfiles')
    expect(names).toContain('sops')
    expect(names).toContain('csl-agent-kit')
    expect(names).toContain('mac-apps')
    expect(names).toContain('homebrew')
    expect(names).toContain('raycast')
  })

  it('should resolve enabled plugins from config names', () => {
    const enabled = getEnabledPlugins(['vscode', 'mac-apps'])
    expect(enabled).toHaveLength(2)
    expect(enabled[0]?.name).toBe('vscode')
    expect(enabled[1]?.name).toBe('mac-apps')
  })

  it('should skip unknown plugin names', () => {
    const enabled = getEnabledPlugins(['vscode', 'nonexistent'])
    expect(enabled).toHaveLength(1)
    expect(enabled[0]?.name).toBe('vscode')
  })

  it('should return builtin plugin definitions', () => {
    const plugin = getBuiltinPlugin('mac-apps')
    expect(plugin?.prepare).toBe('mac-apps-inventory')
    expect(plugin?.paths[0]).toContain('mac-apps.json')
  })

  it('should return VS Code extensions inventory plugin definition', () => {
    const plugin = getBuiltinPlugin('vscode-extensions')
    expect(plugin?.prepare).toBe('vscode-extensions-list')
    expect(plugin?.paths).toEqual(['~/.config/restore/inventory/vscode-extensions.txt'])
  })

  it('should return Homebrew and Raycast plugin definitions', () => {
    const homebrew = getBuiltinPlugin('homebrew')
    expect(homebrew?.prepare).toBe('homebrew-brewfile')
    expect(homebrew?.paths[0]).toContain('Brewfile')

    const raycast = getBuiltinPlugin('raycast')
    expect(raycast?.paths).toEqual([
      '~/.config/restore/inventory/raycast-extensions.json',
      '~/Library/Preferences/com.raycast.macos.plist',
    ])
    expect(raycast?.prepare).toBe('raycast-extensions')
  })

  it('should return restore-cli config plugin definition', () => {
    const plugin = getBuiltinPlugin('restore-cli')
    expect(plugin?.paths).toEqual(['~/.config/restore/config.json5'])
  })

  it('should return SOPS plugin definition', () => {
    const plugin = getBuiltinPlugin('sops')
    expect(plugin?.paths).toEqual(['~/.sops'])
  })

  it('should return CSL Agent Kit plugin definition', () => {
    const plugin = getBuiltinPlugin('csl-agent-kit')
    expect(plugin?.paths).toEqual(['~/.csl-agent-kit'])
  })
})

describe('user plugin loader', () => {
  it('loads strict declarative JSON with conservative sensitivity and no executable fields', async () => {
    const directory = await pluginDirectory()
    await writeFile(
      join(directory, 'custom.json'),
      JSON.stringify({
        name: 'custom',
        description: 'custom settings',
        sources: [
          {
            name: 'settings',
            path: '/tmp/custom-settings',
            requirement: 'required',
            expectedType: 'file',
            recoveryScope: 'exact',
          },
        ],
      }),
    )

    const plugins = loadUserPlugins(directory)

    expect(plugins).toHaveLength(1)
    expect(plugins[0]?.sources[0]).toMatchObject({
      sensitivity: 'secret',
      requirement: 'required',
    })
    expect(plugins[0]?.paths).toEqual(['/tmp/custom-settings'])

    await writeFile(
      join(directory, 'executable.json'),
      JSON.stringify({
        name: 'executable',
        description: 'must be rejected',
        paths: ['/tmp/value'],
        prepare: 'arbitrary-code',
      }),
    )
    expect(() => loadUserPlugins(directory)).toThrowError(/invalid/)
  })

  it('maps legacy paths to optional/private sources', async () => {
    const directory = await pluginDirectory()
    await writeFile(
      join(directory, 'legacy.json'),
      JSON.stringify({ name: 'legacy', description: 'legacy plugin', paths: ['/tmp/legacy'] }),
    )

    expect(loadUserPlugins(directory)[0]?.sources).toEqual([
      {
        name: 'path-1',
        path: '/tmp/legacy',
        requirement: 'optional',
        sensitivity: 'private',
        expectedType: 'any',
        recoveryScope: 'exact',
        includeEmptyDirectories: false,
      },
    ])
  })

  it('rejects malformed, unknown, duplicate, and no-follow plugin inputs', async () => {
    const malformed = await pluginDirectory()
    await writeFile(join(malformed, 'bad.json'), '{ bad')
    expect(() => loadUserPlugins(malformed)).toThrowError(/invalid/)

    const unknown = await pluginDirectory()
    await writeFile(
      join(unknown, 'unknown.json'),
      JSON.stringify({
        name: 'unknown',
        description: 'unknown field',
        paths: ['/tmp/a'],
        extra: true,
      }),
    )
    expect(() => loadUserPlugins(unknown)).toThrowError(/invalid/)

    const duplicate = await pluginDirectory()
    for (const filename of ['one.json', 'two.json']) {
      await writeFile(
        join(duplicate, filename),
        JSON.stringify({ name: 'same', description: filename, paths: [`/tmp/${filename}`] }),
      )
    }
    expect(() => loadUserPlugins(duplicate)).toThrowError(/duplicated/)

    const noFollow = await pluginDirectory()
    const outside = join(noFollow, '..', 'outside.json')
    await writeFile(
      outside,
      JSON.stringify({ name: 'outside', description: 'outside', paths: ['/tmp/outside'] }),
    )
    await symlink(outside, join(noFollow, 'linked.json'))
    expect(() => loadUserPlugins(noFollow)).toThrowError(/regular no-follow/)
  })

  it('rejects a user plugin that duplicates a built-in name or source name', async () => {
    const builtinDuplicate = await pluginDirectory()
    await writeFile(
      join(builtinDuplicate, 'duplicate.json'),
      JSON.stringify({ name: 'git', description: 'duplicate', paths: ['/tmp/git'] }),
    )
    expect(() => loadUserPlugins(builtinDuplicate)).toThrowError(/duplicated/)

    const sourceDuplicate = await pluginDirectory()
    const source = {
      name: 'same',
      path: '/tmp/source',
      requirement: 'optional',
      expectedType: 'any',
      recoveryScope: 'exact',
    }
    await writeFile(
      join(sourceDuplicate, 'duplicate.json'),
      JSON.stringify({
        name: 'duplicate-sources',
        description: 'duplicate sources',
        sources: [source, source],
      }),
    )
    expect(() => loadUserPlugins(sourceDuplicate)).toThrowError(/invalid/)
  })

  it('rejects same-size plugin mutation after the held file descriptor is opened', async () => {
    const directory = await pluginDirectory()
    const path = join(directory, 'mutable.json')
    const first = JSON.stringify({ name: 'alpha', description: 'first', paths: ['/tmp/one'] })
    const second = JSON.stringify({ name: 'bravo', description: 'other', paths: ['/tmp/two'] })
    expect(second.length).toBe(first.length)
    await writeFile(path, first)

    expect(() =>
      loadUserPlugins(directory, {
        onPluginReadStart(file) {
          writeFileSync(file, second)
        },
      }),
    ).toThrowError(/changed while being read/)
  })

  it('rejects direct and nested plugin-directory ABA replacement', async () => {
    for (const nested of [false, true]) {
      const root = await mkdtemp(join(tmpdir(), 'restore-plugin-aba-'))
      temporaryDirectories.push(root)
      const parent = nested ? join(root, 'parent') : root
      const directory = join(parent, 'plugins')
      await mkdir(directory, { recursive: true })
      const path = join(directory, 'plugin.json')
      const content = JSON.stringify({ name: 'alpha', description: 'first', paths: ['/tmp/one'] })
      await writeFile(path, content)
      let swapped = false

      expect(() =>
        loadUserPlugins(directory, {
          onPluginReadStart() {
            if (swapped) return
            swapped = true
            const target = nested ? parent : directory
            renameSync(target, `${target}.moved`)
            mkdirSync(target, { recursive: true })
            const replacementDirectory = nested ? join(target, 'plugins') : target
            mkdirSync(replacementDirectory, { recursive: true })
            writeFileSync(join(replacementDirectory, 'plugin.json'), content)
          },
        }),
      ).toThrowError(/directory changed/)
    }
  })
})

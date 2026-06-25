import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { preparePlugins } from './prepare.js'
import {
  collectRaycastExtensions,
  generateRaycastExtensionsInventory,
} from './raycast-inventory.js'

function createExtension(root: string, id: string, pkg?: Record<string, unknown>): string {
  const extensionPath = resolve(root, id)
  mkdirSync(extensionPath, { recursive: true })
  if (pkg) {
    writeFileSync(resolve(extensionPath, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  }
  mkdirSync(resolve(extensionPath, 'com.raycast.api.cache'), { recursive: true })
  writeFileSync(resolve(extensionPath, 'com.raycast.api.cache', 'cache-entry'), 'cache')
  return extensionPath
}

describe('raycast inventory', () => {
  it('collects extension directories without traversing caches', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'restore-raycast-'))
    const extensionPath = createExtension(root, 'local-extension', {
      name: 'local-extension',
      title: 'Local Extension',
      version: '1.2.3',
      description: 'Test extension',
    })

    const extensions = await collectRaycastExtensions(root)

    expect(extensions).toEqual([
      {
        id: 'local-extension',
        path: extensionPath,
        packageName: 'local-extension',
        title: 'Local Extension',
        version: '1.2.3',
        description: 'Test extension',
      },
    ])

    await rm(root, { recursive: true, force: true })
  })

  it('writes a Raycast extensions inventory file', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'restore-raycast-json-'))
    const extensionsRoot = resolve(root, 'extensions')
    const outputPath = resolve(root, 'raycast-extensions.json')
    createExtension(extensionsRoot, 'uuid-extension')

    const inventory = await generateRaycastExtensionsInventory(outputPath, extensionsRoot)
    const saved = JSON.parse(readFileSync(outputPath, 'utf-8'))

    expect(inventory.extensionCount).toBe(1)
    expect(saved.extensions[0].id).toBe('uuid-extension')

    await rm(root, { recursive: true, force: true })
  })

  it('preparePlugins generates Raycast inventory before backup', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'restore-raycast-prepare-'))
    const outputPath = resolve(root, 'raycast-extensions.json')

    await preparePlugins([
      {
        name: 'raycast',
        description: 'test',
        paths: [outputPath],
        prepare: 'raycast-extensions',
      },
    ])

    const inventory = JSON.parse(readFileSync(outputPath, 'utf-8'))
    expect(Array.isArray(inventory.extensions)).toBe(true)

    await rm(root, { recursive: true, force: true })
  })
})

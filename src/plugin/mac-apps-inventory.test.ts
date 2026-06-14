import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findAppBundles,
  generateMacAppsInventory,
  readAppMetadata,
  shouldSkipScanDir,
} from './mac-apps-inventory.js'
import { preparePlugins } from './prepare.js'

const MINIMAL_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>TestApp</string>
  <key>CFBundleIdentifier</key>
  <string>com.example.testapp</string>
  <key>CFBundleShortVersionString</key>
  <string>1.2.3</string>
  <key>CFBundleVersion</key>
  <string>456</string>
</dict>
</plist>`

function createFakeApp(root: string, appName: string): string {
  const appPath = resolve(root, `${appName}.app`)
  const contentsDir = resolve(appPath, 'Contents')
  mkdirSync(contentsDir, { recursive: true })
  writeFileSync(resolve(contentsDir, 'Info.plist'), MINIMAL_PLIST, 'utf-8')
  return appPath
}

describe('mac-apps-inventory', () => {
  it('finds app bundles recursively', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'restore-mac-apps-'))
    createFakeApp(resolve(root, 'Nested'), 'Example')

    const apps = await findAppBundles(root)
    expect(apps.some((app) => app.endsWith('Example.app'))).toBe(true)

    await rm(root, { recursive: true, force: true })
  })

  it('skips system utility scan roots', () => {
    expect(shouldSkipScanDir('/Applications/Utilities')).toBe(true)
    expect(shouldSkipScanDir('/Applications/Utilities/Terminal.app')).toBe(true)
    expect(shouldSkipScanDir('/Applications/Firefox.app')).toBe(false)
  })

  it('writes a JSON inventory file', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'restore-mac-apps-json-'))
    const outputPath = resolve(root, 'inventory', 'mac-apps.json')

    const inventory = await generateMacAppsInventory(outputPath)
    const saved = JSON.parse(readFileSync(outputPath, 'utf-8'))

    expect(saved.generatedAt).toBeTruthy()
    expect(saved.apps).toEqual(inventory.apps)
    expect(saved.platform).toBe(platform() === 'darwin' ? 'darwin' : 'other')

    await rm(root, { recursive: true, force: true })
  })

  it('reads metadata from a fake app on macOS', () => {
    if (platform() !== 'darwin') return

    const root = mkdtempSync(resolve(tmpdir(), 'restore-mac-apps-meta-'))
    const appPath = createFakeApp(root, 'Example')
    const metadata = readAppMetadata(appPath)

    expect(metadata).toMatchObject({
      name: 'TestApp',
      bundleId: 'com.example.testapp',
      version: '1.2.3',
      build: '456',
      path: appPath,
    })
  })

  it('preparePlugins generates inventory before backup', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'restore-mac-apps-prepare-'))
    const outputPath = resolve(root, 'mac-apps.json')

    await preparePlugins([
      {
        name: 'mac-apps',
        description: 'test',
        paths: [outputPath],
        prepare: 'mac-apps-inventory',
      },
    ])

    const inventory = JSON.parse(readFileSync(outputPath, 'utf-8'))
    expect(inventory.appCount).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(inventory.apps)).toBe(true)

    await rm(root, { recursive: true, force: true })
  })
})

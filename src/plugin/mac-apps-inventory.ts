import { execFileSync } from 'node:child_process'
import { type Dirent, existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { basename, resolve } from 'node:path'
import { debug } from '../util/log.js'
import { expandPath } from '../util/path.js'

export const MAC_APPS_INVENTORY_RELATIVE_PATH = '~/.config/restore/inventory/mac-apps.json'

export interface MacAppEntry {
  name: string
  bundleId: string | null
  version: string | null
  build: string | null
  path: string
}

export interface MacAppsInventory {
  generatedAt: string
  platform: 'darwin' | 'other'
  appCount: number
  apps: MacAppEntry[]
}

const SCAN_ROOTS = ['~/Applications', '/Applications'] as const
const EXCLUDED_PREFIXES = ['/Applications/Utilities', '/System/']

export function shouldSkipScanDir(dir: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => dir === prefix || dir.startsWith(`${prefix}/`))
}

/// Recursively find `.app` bundles under `root`, skipping nested bundles inside other apps.
export async function findAppBundles(root: string): Promise<string[]> {
  const apps: string[] = []

  async function walk(dir: string): Promise<void> {
    if (shouldSkipScanDir(dir)) return

    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name.toString())
      if (entry.name.toString().endsWith('.app')) {
        apps.push(fullPath)
        continue
      }
      if (entry.isDirectory()) {
        await walk(fullPath)
      }
    }
  }

  await walk(root)
  return apps
}

function infoPlistPath(appPath: string): string {
  return resolve(appPath, 'Contents', 'Info.plist')
}

function readInfoPlist(plistPath: string): Record<string, unknown> | null {
  if (!existsSync(plistPath)) return null
  try {
    const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plistPath], {
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

function plistString(plist: Record<string, unknown>, key: string): string | null {
  const value = plist[key]
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

export function readAppMetadata(appPath: string): MacAppEntry {
  const plist = readInfoPlist(infoPlistPath(appPath))
  const name =
    (plist && plistString(plist, 'CFBundleName')) ??
    (plist && plistString(plist, 'CFBundleDisplayName')) ??
    basename(appPath, '.app')

  return {
    name,
    bundleId: plist ? plistString(plist, 'CFBundleIdentifier') : null,
    version: plist ? plistString(plist, 'CFBundleShortVersionString') : null,
    build: plist ? plistString(plist, 'CFBundleVersion') : null,
    path: appPath,
  }
}

function dedupeByBundleId(apps: MacAppEntry[]): MacAppEntry[] {
  const byId = new Map<string, MacAppEntry>()
  const homeApps = `${homedir()}/Applications`

  for (const app of apps) {
    const key = app.bundleId ?? app.path
    const existing = byId.get(key)
    if (!existing) {
      byId.set(key, app)
      continue
    }

    const preferCurrent = app.path.startsWith(homeApps) && !existing.path.startsWith(homeApps)
    if (preferCurrent) {
      byId.set(key, app)
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function collectDarwinApps(): Promise<MacAppEntry[]> {
  const discovered = new Set<string>()
  for (const root of SCAN_ROOTS) {
    const bundles = await findAppBundles(expandPath(root))
    for (const bundle of bundles) {
      discovered.add(bundle)
    }
  }

  return dedupeByBundleId([...discovered].map(readAppMetadata))
}

/// Scan non-system Mac applications and write a JSON inventory file.
export async function generateMacAppsInventory(outputPath: string): Promise<MacAppsInventory> {
  const resolvedOutput = expandPath(outputPath)
  await mkdir(resolve(resolvedOutput, '..'), { recursive: true })

  const apps = platform() === 'darwin' ? await collectDarwinApps() : []
  const inventory: MacAppsInventory = {
    generatedAt: new Date().toISOString(),
    platform: platform() === 'darwin' ? 'darwin' : 'other',
    appCount: apps.length,
    apps,
  }

  await writeFile(resolvedOutput, `${JSON.stringify(inventory, null, 2)}\n`, 'utf-8')
  debug(`Generated Mac apps inventory: ${resolvedOutput} (${apps.length} apps)`)

  return inventory
}

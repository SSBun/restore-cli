import { type Dirent, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expandPath } from '../util/path.js'

export const RAYCAST_EXTENSIONS_INVENTORY_RELATIVE_PATH =
  '~/.config/restore/inventory/raycast-extensions.json'
export const RAYCAST_EXTENSIONS_RELATIVE_PATH =
  '~/Library/Application Support/com.raycast.macos/extensions'

export interface RaycastExtensionEntry {
  id: string
  path: string
  packageName: string | null
  title: string | null
  version: string | null
  description: string | null
}

export interface RaycastExtensionsInventory {
  generatedAt: string
  extensionCount: number
  extensions: RaycastExtensionEntry[]
}

function packageString(pkg: Record<string, unknown>, key: string): string | null {
  const value = pkg[key]
  return typeof value === 'string' && value.trim() ? value : null
}

async function readPackageMetadata(extensionPath: string): Promise<{
  packageName: string | null
  title: string | null
  version: string | null
  description: string | null
}> {
  const packagePath = resolve(extensionPath, 'package.json')
  if (!existsSync(packagePath)) {
    return { packageName: null, title: null, version: null, description: null }
  }

  try {
    const pkg = JSON.parse(await readFile(packagePath, 'utf-8')) as Record<string, unknown>
    return {
      packageName: packageString(pkg, 'name'),
      title: packageString(pkg, 'title'),
      version: packageString(pkg, 'version'),
      description: packageString(pkg, 'description'),
    }
  } catch {
    return { packageName: null, title: null, version: null, description: null }
  }
}

export async function collectRaycastExtensions(
  extensionsRoot = expandPath(RAYCAST_EXTENSIONS_RELATIVE_PATH),
): Promise<RaycastExtensionEntry[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(extensionsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const extensions: RaycastExtensionEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const extensionPath = resolve(extensionsRoot, entry.name)
    extensions.push({
      id: entry.name,
      path: extensionPath,
      ...(await readPackageMetadata(extensionPath)),
    })
  }

  return extensions.sort((a, b) => a.id.localeCompare(b.id))
}

export async function generateRaycastExtensionsInventory(
  outputPath: string,
  extensionsRoot?: string,
): Promise<RaycastExtensionsInventory> {
  const resolvedOutput = expandPath(outputPath)
  await mkdir(resolve(resolvedOutput, '..'), { recursive: true })

  const extensions = await collectRaycastExtensions(extensionsRoot)
  const inventory: RaycastExtensionsInventory = {
    generatedAt: new Date().toISOString(),
    extensionCount: extensions.length,
    extensions,
  }

  await writeFile(resolvedOutput, `${JSON.stringify(inventory, null, 2)}\n`, 'utf-8')
  return inventory
}

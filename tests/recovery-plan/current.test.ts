import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  scanBoundedMacApplications,
  scanBoundedRaycastExtensions,
} from '../../src/recovery-plan/index.js'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'restore-current-scan-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('bounded current-machine application scans', () => {
  it('streams bounded Raycast packages and records exact scan totals', async () => {
    const root = await temporaryRoot()
    const extension = join(root, 'github')
    await mkdir(extension)
    const payload = '{"title":"GitHub"}\n'
    await writeFile(join(extension, 'package.json'), payload)
    const scan = await scanBoundedRaycastExtensions({ raycastRoot: root })
    expect(scan).toEqual({
      items: [{ id: 'github', title: 'GitHub' }],
      complete: true,
      entriesVisited: 1,
      bytesRead: Buffer.byteLength(payload),
      maxDepthVisited: 1,
      issues: [],
    })
  })

  it('marks symlink and oversized Raycast entries incomplete', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'target')
    const extension = join(root, 'large')
    await mkdir(target)
    await mkdir(extension)
    await symlink(target, join(root, 'linked'))
    await writeFile(join(extension, 'package.json'), '{"title":"Too large"}')
    const scan = await scanBoundedRaycastExtensions({
      raycastRoot: root,
      limits: { maxFileBytes: 4 },
    })
    expect(scan.complete).toBe(false)
    expect(scan.issues).toEqual(
      expect.arrayContaining(['raycast-package-unsafe', 'scan-symlink-skipped']),
    )
  })

  it('stops Mac traversal at explicit depth and time limits', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'one', 'two'), { recursive: true })
    const depth = await scanBoundedMacApplications({
      macRoots: [root],
      limits: { maxDepth: 1 },
    })
    expect(depth.complete).toBe(false)
    expect(depth.issues).toContain('scan-depth-limit-exceeded')

    let clock = 0
    const timed = await scanBoundedMacApplications({
      macRoots: [root],
      limits: { timeoutMs: 1 },
      now: () => {
        clock += 10
        return clock
      },
    })
    expect(timed.complete).toBe(false)
    expect(timed.issues).toContain('scan-time-limit-exceeded')
  })

  it('does not follow an unsafe Mac scan root', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'real')
    await mkdir(target)
    await symlink(target, join(root, 'alias'))
    const scan = await scanBoundedMacApplications({ macRoots: [join(root, 'alias')] })
    expect(scan).toMatchObject({ items: [], complete: false })
    expect(scan.issues).toContain('scan-directory-unsafe')
  })

  it('does not traverse an attacker tree when a Mac scan root is replaced before binding', async () => {
    const root = await temporaryRoot()
    const applications = join(root, 'Applications')
    const displaced = join(root, 'displaced-applications')
    const attacker = join(root, 'attacker-applications')
    await mkdir(applications)
    await mkdir(join(attacker, 'Attacker.app'), { recursive: true })
    let swapped = false
    const scan = await scanBoundedMacApplications({
      macRoots: [applications],
      async beforeDirectoryBind(path) {
        if (swapped || path !== applications) return
        swapped = true
        await rename(applications, displaced)
        await symlink(attacker, applications)
      },
    })
    expect(swapped).toBe(true)
    expect(scan.items).toEqual([])
    expect(scan.complete).toBe(false)
    expect(scan.issues).toContain('scan-directory-read-failed')
  })

  it('does not read an attacker package when a nested Raycast directory is replaced', async () => {
    const root = await temporaryRoot()
    const raycast = join(root, 'raycast')
    const extension = join(raycast, 'github')
    const displaced = join(root, 'displaced-extension')
    const attacker = join(root, 'attacker-extension')
    await mkdir(extension, { recursive: true })
    await mkdir(attacker)
    await writeFile(join(extension, 'package.json'), '{"title":"Safe"}')
    await writeFile(join(attacker, 'package.json'), '{"title":"Attacker"}')
    let swapped = false
    const scan = await scanBoundedRaycastExtensions({
      raycastRoot: raycast,
      async beforeDirectoryBind(path) {
        if (swapped || path !== extension) return
        swapped = true
        await rename(extension, displaced)
        await symlink(attacker, extension)
      },
    })
    expect(swapped).toBe(true)
    expect(scan.items).toEqual([{ id: 'github', title: null }])
    expect(scan.complete).toBe(false)
    expect(scan.issues).toContain('scan-directory-read-failed')
    expect(JSON.stringify(scan)).not.toContain('Attacker')
  })

  it('rejects Info.plist metadata changed after conversion under the held file descriptor', async () => {
    const root = await temporaryRoot()
    const application = join(root, 'Fallback.app')
    const contents = join(application, 'Contents')
    await mkdir(contents, { recursive: true })
    await writeFile(
      join(contents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>AuthenticatedName</string>
<key>CFBundleIdentifier</key><string>example.authenticated</string>
</dict></plist>`,
    )
    const scan = await scanBoundedMacApplications({
      macRoots: [root],
      testMutateBoundFileBeforeFinalCheck: true,
    })
    expect(scan).toMatchObject({
      complete: false,
      items: [{ name: 'Fallback', bundleId: null, path: application }],
    })
    expect(scan.issues).toContain('mac-app-plist-unsafe')
    expect(JSON.stringify(scan)).not.toContain('AuthenticatedName')
    expect(JSON.stringify(scan)).not.toContain('example.authenticated')
  })
})

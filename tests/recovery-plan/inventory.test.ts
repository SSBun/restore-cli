import { describe, expect, it } from 'vitest'
import {
  compareExpectedInventory,
  parseAllowlistedBrewfile,
  parseAllowlistedVSCodeInventory,
  parseMacAppsInventory,
  parseRaycastInventory,
  synthesizeBrewfile,
} from '../../src/recovery-plan/inventory.js'

describe('recovery plan inventory', () => {
  it('parses only exact declarative brew and cask statements', () => {
    const parsed = parseAllowlistedBrewfile(`
brew "git"
cask 'visual-studio-code'
brew "git"
tap "homebrew/cask"
mas "Xcode", id: 497799835
brew "node", restart_service: true
brew "bad; touch /tmp/owned"
system "touch /tmp/owned"
`)

    expect(parsed.taps).toEqual(['homebrew/cask'])
    expect(parsed.formulae).toEqual(['git'])
    expect(parsed.casks).toEqual(['visual-studio-code'])
    expect(parsed.manual.map((item) => item.id)).toEqual([
      'homebrew-line-6',
      'homebrew-line-7',
      'homebrew-line-8',
      'homebrew-line-9',
    ])
  })

  it('never reuses Brewfile source lines when synthesizing an install file', () => {
    const parsed = parseAllowlistedBrewfile('brew "git"\nsystem "touch /tmp/owned"\n')
    const output = synthesizeBrewfile([
      ...parsed.formulae.map((value) => ({ kind: 'homebrew-formula' as const, value })),
      ...parsed.casks.map((value) => ({ kind: 'homebrew-cask' as const, value })),
    ])

    expect(output).toContain('brew "git"')
    expect(output).not.toContain('system')
    expect(output).not.toContain('owned')
  })

  it('enforces directive-specific Homebrew segment grammars', () => {
    const parsed = parseAllowlistedBrewfile(`
tap "owner/repo"
brew "git"
brew "owner/repo/tool@2"
cask "owner/repo/app"
tap "owner/repo/extra"
brew "owner/repo"
cask "owner//app"
brew "owner/../tool"
tap "owner/"
brew "/absolute"
`)
    expect(parsed.taps).toEqual(['owner/repo'])
    expect(parsed.formulae).toEqual(['git', 'owner/repo/tool@2'])
    expect(parsed.casks).toEqual(['owner/repo/app'])
    expect(parsed.manual).toHaveLength(6)
    expect(() =>
      synthesizeBrewfile([{ kind: 'homebrew-formula', value: 'owner/../tool' }]),
    ).toThrow(/invalid identifier/)
    expect(() => synthesizeBrewfile([{ kind: 'homebrew-tap', value: 'owner/repo/extra' }])).toThrow(
      /invalid identifier/,
    )
  })

  it('accepts only bounded publisher.extension identifiers', () => {
    const parsed = parseAllowlistedVSCodeInventory(
      'dbaeumer.vscode-eslint\ndbaeumer.vscode-eslint\ninvalid\na.b;touch\n# unavailable\n',
    )
    expect(parsed.extensions).toEqual(['dbaeumer.vscode-eslint'])
    expect(parsed.manual).toHaveLength(2)
  })

  it('validates bounded JSON inventory records', () => {
    expect(
      parseMacAppsInventory(
        JSON.stringify({
          generatedAt: '2026-07-19T00:00:00.000Z',
          platform: 'darwin',
          appCount: 1,
          apps: [
            {
              name: 'Arc',
              bundleId: 'company.thebrowser.Browser',
              version: '1',
              build: '1',
              path: '/Applications/Arc.app',
            },
          ],
        }),
      ),
    ).toEqual([
      { name: 'Arc', bundleId: 'company.thebrowser.Browser', path: '/Applications/Arc.app' },
    ])
    expect(
      parseRaycastInventory(
        JSON.stringify({
          generatedAt: '2026-07-19T00:00:00.000Z',
          extensionCount: 1,
          extensions: [
            {
              id: 'github',
              path: '/tmp/github',
              packageName: 'github',
              title: 'GitHub',
              version: '1',
              description: null,
            },
          ],
        }),
      ),
    ).toEqual([{ id: 'github', title: 'GitHub' }])
    expect(() => parseMacAppsInventory('{"apps":[{"name":"Arc"}]}')).toThrow()
    expect(() => parseRaycastInventory('{"extensions":[{"id":"x;rm"}]}')).toThrow()
  })

  it('builds deterministic missing-only actions while keeping apps manual', () => {
    const comparison = compareExpectedInventory(
      {
        homebrew: { taps: [], formulae: ['git', 'node'], casks: ['iterm2'] },
        vscodeExtensions: ['dbaeumer.vscode-eslint'],
        macApps: [
          { name: 'Arc', bundleId: 'company.thebrowser.Browser', path: '/Applications/Arc.app' },
        ],
        raycastExtensions: [{ id: 'github', title: 'GitHub' }],
        manual: [],
      },
      {
        homebrew: { available: true, taps: [], formulae: ['git'], casks: [] },
        vscode: { available: true, extensions: [] },
        macApps: {
          items: [],
          complete: true,
          entriesVisited: 0,
          bytesRead: 0,
          maxDepthVisited: 0,
          issues: [],
        },
        raycastExtensions: {
          items: [],
          complete: true,
          entriesVisited: 0,
          bytesRead: 0,
          maxDepthVisited: 0,
          issues: [],
        },
      },
    )

    expect(comparison.actions.map((action) => action.id)).toEqual([
      'homebrew-cask:iterm2',
      'homebrew-formula:node',
      'vscode-extension:dbaeumer.vscode-eslint',
    ])
    expect(comparison.software.find((item) => item.kind === 'mac-app')).toMatchObject({
      status: 'missing',
      recovery: 'manual',
    })
    expect(comparison.software.find((item) => item.kind === 'raycast-extension')).toMatchObject({
      status: 'missing',
      recovery: 'manual',
    })
  })

  it('reports expected apps unknown rather than missing when bounded scans are incomplete', () => {
    const comparison = compareExpectedInventory(
      {
        homebrew: { taps: [], formulae: [], casks: [] },
        vscodeExtensions: [],
        macApps: [{ name: 'Arc', bundleId: 'company.arc', path: '/Applications/Arc.app' }],
        raycastExtensions: [{ id: 'github', title: 'GitHub' }],
        manual: [],
      },
      {
        homebrew: { available: true, taps: [], formulae: [], casks: [] },
        vscode: { available: true, extensions: [] },
        macApps: {
          items: [],
          complete: false,
          entriesVisited: 1,
          bytesRead: 0,
          maxDepthVisited: 1,
          issues: ['scan-time-limit-exceeded'],
        },
        raycastExtensions: {
          items: [],
          complete: false,
          entriesVisited: 1,
          bytesRead: 0,
          maxDepthVisited: 1,
          issues: ['scan-symlink-skipped'],
        },
      },
    )
    expect(comparison.software.map((item) => item.status)).toEqual(['unknown', 'unknown'])
    expect(comparison.manual.map((item) => item.id)).toEqual([
      'mac-apps-current-scan-incomplete',
      'raycast-current-scan-incomplete',
    ])
  })

  it('rejects oversized and nul-containing inventories', () => {
    expect(() => parseAllowlistedBrewfile(`brew "${'a'.repeat(5000)}"`)).toThrow()
    expect(() => parseAllowlistedVSCodeInventory('a.b\0c.d')).toThrow()
  })

  it('deduplicates exact JSON identities but rejects conflicting duplicates', () => {
    const app = {
      name: 'Arc',
      bundleId: 'company.thebrowser.Browser',
      version: '1',
      build: '1',
      path: '/Applications/Arc.app',
    }
    const base = {
      generatedAt: '2026-07-19T00:00:00.000Z',
      platform: 'darwin',
      appCount: 2,
      apps: [app, { ...app }],
    }
    expect(parseMacAppsInventory(JSON.stringify(base))).toHaveLength(1)
    expect(() =>
      parseMacAppsInventory(JSON.stringify({ ...base, apps: [app, { ...app, version: '2' }] })),
    ).toThrow(/conflicting duplicate/)
  })
})

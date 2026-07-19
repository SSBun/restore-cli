import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCapturePlan } from '../../src/catalog/index.js'
import { createV1RecoveryPoint } from '../../src/engine/v1-backup.js'
import type { PluginManifest, SourceSpec } from '../../src/plugin/types.js'
import type { CurrentMachineInventory, RecoveryPlanOptions } from '../../src/recovery-plan/index.js'
import { initializeRepository } from '../../src/repository/index.js'

const fixedNow = () => new Date('2026-07-19T00:00:00.000Z')

function plugin(
  name: string,
  sourceName: string,
  path: string,
  recoveryScope: 'exact' | 'inventory',
  requirement: 'required' | 'optional' = 'required',
): PluginManifest {
  const source: SourceSpec = {
    name: sourceName,
    path,
    requirement,
    sensitivity: recoveryScope === 'inventory' ? 'public' : 'private',
    expectedType: 'file',
    recoveryScope,
  }
  return { name, description: 'recovery plan fixture', paths: [path], sources: [source] }
}

export interface RecoveryPlanFixture {
  root: string
  stateDirectory: string
  lockRoot: string
  options: RecoveryPlanOptions
  current: CurrentMachineInventory
}

export async function createRecoveryPlanFixture(
  options: {
    includeInventories?: boolean
    includeMissingConfig?: boolean
    invalidMacAppsInventory?: boolean
    includeUnknownInventory?: boolean
  } = {},
): Promise<RecoveryPlanFixture> {
  const created = await mkdtemp(join(tmpdir(), 'restore-plan-'))
  const root = await realpath(created)
  const repositoryTarget = join(root, 'repository-target')
  const stagingRoot = join(root, 'staging')
  const stateDirectory = join(root, 'state')
  const lockRoot = join(root, 'locks')
  const sources = join(root, 'sources')
  await Promise.all([
    mkdir(repositoryTarget),
    mkdir(stagingRoot),
    mkdir(stateDirectory),
    mkdir(lockRoot),
    mkdir(sources),
  ])
  await chmod(stateDirectory, 0o700)
  await chmod(lockRoot, 0o700)
  const brewfile = join(sources, 'Brewfile')
  const vscode = join(sources, 'vscode.txt')
  const macApps = join(sources, 'mac-apps.json')
  const raycast = join(sources, 'raycast.json')
  const config = join(sources, 'zshrc')
  const unknownInventory = join(sources, 'unknown-inventory.txt')
  await Promise.all([
    writeFile(brewfile, 'tap "homebrew/cask"\nbrew "git"\nbrew "node"\ncask "iterm2"\n'),
    writeFile(vscode, 'dbaeumer.vscode-eslint\nesbenp.prettier-vscode\n'),
    writeFile(
      macApps,
      options.invalidMacAppsInventory
        ? '{invalid-json'
        : `${JSON.stringify({
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
          })}\n`,
    ),
    writeFile(
      raycast,
      `${JSON.stringify({
        generatedAt: '2026-07-19T00:00:00.000Z',
        extensionCount: 1,
        extensions: [
          {
            id: 'github',
            path: '/tmp/raycast/github',
            packageName: 'github',
            title: 'GitHub',
            version: '1',
            description: null,
          },
        ],
      })}\n`,
    ),
    writeFile(config, 'export PLAN_FIXTURE=1\n'),
    writeFile(unknownInventory, 'manual inventory\n'),
  ])
  const initialized = await initializeRepository({
    targetPath: repositoryTarget,
    protection: 'plaintext',
    now: fixedNow,
  })
  const inventoryPlugins = [
    plugin('homebrew', 'brewfile', brewfile, 'inventory'),
    plugin('vscode-extensions', 'extensions', vscode, 'inventory'),
    plugin('mac-apps', 'applications', macApps, 'inventory'),
    plugin('raycast', 'extensions', raycast, 'inventory'),
  ]
  const backup = await createV1RecoveryPoint({
    repositoryPath: initialized.repositoryPath,
    expectedRepositoryId: initialized.repositoryId,
    expectedProtection: 'plaintext',
    pointId: 'healthy-point',
    now: fixedNow,
    plan: buildCapturePlan([
      ...(options.includeInventories === false ? [] : inventoryPlugins),
      plugin('zsh', 'zshrc', config, 'exact'),
      ...(options.includeMissingConfig
        ? [plugin('git', 'config', join(sources, 'missing-gitconfig'), 'exact', 'optional')]
        : []),
      ...(options.includeUnknownInventory
        ? [plugin('unknown-inventory', 'applications', unknownInventory, 'inventory')]
        : []),
    ]),
  })
  if (backup.state !== 'success' && backup.state !== 'warning')
    throw new Error(`fixture backup failed: ${JSON.stringify(backup)}`)
  return {
    root,
    stateDirectory,
    lockRoot,
    options: {
      repositoryPath: initialized.repositoryPath,
      expectedRepositoryId: initialized.repositoryId,
      expectedProtection: 'plaintext',
      pointId: 'healthy-point',
      stagingRoot,
      platform: 'darwin',
      architecture: 'arm64',
      now: fixedNow,
    },
    current: {
      homebrew: { available: true, taps: ['homebrew/cask'], formulae: ['git'], casks: [] },
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
  }
}

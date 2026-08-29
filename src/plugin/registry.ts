import type {
  ExpectedEntryType,
  PluginManifest,
  ResolvedPluginManifest,
  SourceRequirement,
  SourceSensitivity,
  SourceSpec,
} from './types.js'

function source(
  name: string,
  path: string,
  options: {
    requirement?: SourceRequirement
    sensitivity?: SourceSensitivity
    expectedType?: ExpectedEntryType
    recoveryScope?: string
    consistencyGroup?: string
    includeEmptyDirectories?: boolean
    exclude?: string[]
  } = {},
): SourceSpec {
  return {
    name,
    path,
    requirement: options.requirement ?? 'optional',
    sensitivity: options.sensitivity ?? 'private',
    expectedType: options.expectedType ?? 'any',
    recoveryScope: options.recoveryScope ?? 'exact',
    ...(options.consistencyGroup ? { consistencyGroup: options.consistencyGroup } : {}),
    ...(options.includeEmptyDirectories === undefined
      ? {}
      : { includeEmptyDirectories: options.includeEmptyDirectories }),
    ...(options.exclude ? { exclude: options.exclude } : {}),
  }
}

function builtin(plugin: Omit<ResolvedPluginManifest, 'paths'>): ResolvedPluginManifest {
  return { ...plugin, paths: plugin.sources.map((item) => item.path) }
}

const builtinPlugins: ResolvedPluginManifest[] = [
  builtin({
    name: 'restore-cli',
    description: 'restore-cli configuration file',
    sources: [
      source('config', '~/.config/restore/config.json5', {
        requirement: 'required',
        expectedType: 'file',
      }),
    ],
  }),
  builtin({
    name: 'vscode',
    description: 'VS Code settings and keybindings',
    sources: [
      source('settings', '~/Library/Application Support/Code/User/settings.json', {
        expectedType: 'file',
        consistencyGroup: 'vscode-user',
      }),
      source('keybindings', '~/Library/Application Support/Code/User/keybindings.json', {
        expectedType: 'file',
        consistencyGroup: 'vscode-user',
      }),
    ],
  }),
  builtin({
    name: 'vscode-extensions',
    description: 'VS Code installed extensions inventory',
    sources: [
      source('extensions', '~/.config/restore/inventory/vscode-extensions.txt', {
        requirement: 'required',
        sensitivity: 'public',
        expectedType: 'file',
        recoveryScope: 'inventory',
      }),
    ],
    prepare: 'vscode-extensions-list',
  }),
  builtin({
    name: 'ssh',
    description: 'SSH config and keys',
    sources: [source('config', '~/.ssh/config', { sensitivity: 'secret', expectedType: 'file' })],
  }),
  builtin({
    name: 'sops',
    description: 'SOPS configuration and local key material',
    sources: [
      source('configuration', '~/.sops', {
        sensitivity: 'secret',
        expectedType: 'directory',
        includeEmptyDirectories: true,
      }),
    ],
  }),
  builtin({
    name: 'csl-agent-kit',
    description: 'CSL Agent Kit configuration files',
    sources: [
      source('configuration', '~/.csl-agent-kit', {
        expectedType: 'directory',
        includeEmptyDirectories: true,
        exclude: ['.DS_Store', 'hooks/.diagnostics', 'hooks/.tab-title'],
      }),
    ],
  }),
  builtin({
    name: 'zsh',
    description: 'Zsh configuration',
    sources: [
      source('zshrc', '~/.zshrc', { expectedType: 'file', consistencyGroup: 'zsh' }),
      source('zshenv', '~/.zshenv', { expectedType: 'file', consistencyGroup: 'zsh' }),
      source('zprofile', '~/.zprofile', { expectedType: 'file', consistencyGroup: 'zsh' }),
    ],
  }),
  builtin({
    name: 'git',
    description: 'Git configuration',
    sources: [
      source('config', '~/.gitconfig', { expectedType: 'file', consistencyGroup: 'git' }),
      source('ignore-global', '~/.gitignore_global', {
        expectedType: 'file',
        consistencyGroup: 'git',
      }),
    ],
  }),
  builtin({
    name: 'iterm2',
    description: 'iTerm2 preferences',
    sources: [
      source('preferences', '~/Library/Preferences/com.googlecode.iterm2.plist', {
        expectedType: 'file',
      }),
    ],
  }),
  builtin({
    name: 'vim',
    description: 'Vim/Neovim configuration',
    sources: [
      source('vimrc', '~/.vimrc', { expectedType: 'file' }),
      source('neovim', '~/.config/nvim', {
        expectedType: 'directory',
        includeEmptyDirectories: true,
      }),
    ],
  }),
  builtin({
    name: 'homebrew',
    description: 'Homebrew Brewfile inventory for new-Mac package restore',
    sources: [
      source('brewfile', '~/.config/restore/inventory/Brewfile', {
        requirement: 'required',
        sensitivity: 'public',
        expectedType: 'file',
        recoveryScope: 'inventory',
      }),
    ],
    prepare: 'homebrew-brewfile',
  }),
  builtin({
    name: 'raycast',
    description: 'Raycast extension inventory and preferences',
    sources: [
      source('extensions', '~/.config/restore/inventory/raycast-extensions.json', {
        requirement: 'required',
        sensitivity: 'public',
        expectedType: 'file',
        recoveryScope: 'inventory',
        consistencyGroup: 'raycast',
      }),
      source('preferences', '~/Library/Preferences/com.raycast.macos.plist', {
        expectedType: 'file',
        consistencyGroup: 'raycast',
      }),
    ],
    prepare: 'raycast-extensions',
  }),
  builtin({
    name: 'mac-apps',
    description: 'Installed Mac app inventory (JSON manifest for new-Mac recovery)',
    sources: [
      source('applications', '~/.config/restore/inventory/mac-apps.json', {
        requirement: 'required',
        sensitivity: 'public',
        expectedType: 'file',
        recoveryScope: 'inventory',
      }),
    ],
    prepare: 'mac-apps-inventory',
  }),
]

export function getBuiltinPlugins(): PluginManifest[] {
  return builtinPlugins
}

export function getPluginNames(): string[] {
  return builtinPlugins.map((p) => p.name)
}

export function getBuiltinPlugin(name: string): PluginManifest | undefined {
  return builtinPlugins.find((p) => p.name === name)
}

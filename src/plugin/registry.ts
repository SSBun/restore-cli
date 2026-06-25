import type { PluginManifest } from './types.js'

const builtinPlugins: PluginManifest[] = [
  {
    name: 'restore-cli',
    description: 'restore-cli configuration file',
    paths: ['~/.config/restore/config.json5'],
  },
  {
    name: 'vscode',
    description: 'VS Code settings and keybindings',
    paths: [
      '~/Library/Application Support/Code/User/settings.json',
      '~/Library/Application Support/Code/User/keybindings.json',
    ],
  },
  {
    name: 'vscode-extensions',
    description: 'VS Code installed extensions inventory',
    paths: ['~/.config/restore/inventory/vscode-extensions.txt'],
    prepare: 'vscode-extensions-list',
    tools: [
      {
        name: 'refresh',
        description: 'Regenerate the VS Code extensions inventory',
        script: 'refresh.sh',
      },
      {
        name: 'show',
        description: 'Print the saved VS Code extensions inventory',
        script: 'show.sh',
      },
    ],
  },
  {
    name: 'dotfiles',
    description: 'Shell dotfiles (.zshrc, .bashrc, .gitconfig)',
    paths: ['~/.zshrc', '~/.bashrc', '~/.bash_profile', '~/.gitconfig', '~/.gitignore_global'],
  },
  {
    name: 'ssh',
    description: 'SSH config and keys',
    paths: ['~/.ssh/config'],
  },
  {
    name: 'sops',
    description: 'SOPS configuration and local key material',
    paths: ['~/.sops'],
  },
  {
    name: 'zsh',
    description: 'Zsh configuration',
    paths: ['~/.zshrc', '~/.zshenv', '~/.zprofile'],
  },
  {
    name: 'git',
    description: 'Git configuration',
    paths: ['~/.gitconfig', '~/.gitignore_global'],
    tools: [
      {
        name: 'show-config',
        description: 'Print ~/.gitconfig to the terminal',
        script: 'show-config.sh',
      },
    ],
  },
  {
    name: 'iterm2',
    description: 'iTerm2 preferences',
    paths: ['~/Library/Preferences/com.googlecode.iterm2.plist'],
  },
  {
    name: 'vim',
    description: 'Vim/Neovim configuration',
    paths: ['~/.vimrc', '~/.config/nvim'],
  },
  {
    name: 'homebrew',
    description: 'Homebrew Brewfile inventory for new-Mac package restore',
    paths: ['~/.config/restore/inventory/Brewfile'],
    prepare: 'homebrew-brewfile',
    tools: [
      {
        name: 'refresh',
        description: 'Regenerate the Homebrew Brewfile inventory',
        script: 'refresh.sh',
      },
      {
        name: 'show',
        description: 'Print the saved Homebrew Brewfile',
        script: 'show.sh',
      },
    ],
  },
  {
    name: 'raycast',
    description: 'Raycast extension inventory and preferences',
    paths: [
      '~/.config/restore/inventory/raycast-extensions.json',
      '~/Library/Preferences/com.raycast.macos.plist',
    ],
    prepare: 'raycast-extensions',
  },
  {
    name: 'mac-apps',
    description: 'Installed Mac app inventory (JSON manifest for new-Mac recovery)',
    paths: ['~/.config/restore/inventory/mac-apps.json'],
    prepare: 'mac-apps-inventory',
    tools: [
      {
        name: 'list',
        description: 'List cataloged Mac apps from the inventory JSON',
        script: 'list.sh',
      },
      {
        name: 'refresh',
        description: 'Regenerate the app inventory without running a full backup',
        script: 'refresh.sh',
      },
      {
        name: 'restore-plan',
        description: 'Compare this Mac with the inventory and print a manual install plan',
        script: 'restore-plan.sh',
      },
      {
        name: 'open-inventory',
        description: 'Reveal mac-apps.json in Finder',
        script: 'open-inventory.sh',
      },
    ],
  },
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

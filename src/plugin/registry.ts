import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { PluginManifest } from './types.js'

const PLUGINS_DIR = resolve(homedir(), '.config', 'restore', 'plugins')

const builtinPlugins: PluginManifest[] = [
  {
    name: 'vscode',
    description: 'VS Code settings, keybindings, and extensions',
    paths: [
      '~/Library/Application Support/Code/User/settings.json',
      '~/Library/Application Support/Code/User/keybindings.json',
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
    name: 'zsh',
    description: 'Zsh configuration',
    paths: ['~/.zshrc', '~/.zshenv', '~/.zprofile'],
  },
  {
    name: 'git',
    description: 'Git configuration',
    paths: ['~/.gitconfig', '~/.gitignore_global'],
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

export function getPluginDir(): string {
  return PLUGINS_DIR
}

export function ensurePluginDir(): void {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true })
  }
}

export function addPlugin(name: string): boolean {
  const plugin = getBuiltinPlugin(name)
  if (!plugin) return false

  ensurePluginDir()
  const targetPath = resolve(PLUGINS_DIR, `${name}.json`)
  writeFileSync(targetPath, JSON.stringify(plugin, null, 2), 'utf-8')
  return true
}

export function getInstalledPlugins(): string[] {
  ensurePluginDir()
  try {
    return readdirSync(PLUGINS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
  } catch {
    return []
  }
}

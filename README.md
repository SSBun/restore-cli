# @ssbun/restore-cli

Back up important files to iCloud Drive (or other destinations) with snapshot-based versioning.

## Install

```bash
npm install -g @ssbun/restore-cli
```

## Usage

```bash
# Run setup wizard
restore-cli config

# List available plugins
restore-cli plugin list

# Install a plugin
restore-cli plugin add vscode

# Run a backup
restore-cli backup

# List snapshots
restore-cli restore --list

# Restore from a snapshot
restore-cli restore

# Start background daemon
restore-cli daemon start
```

## How it works

- Plugins define what to back up (VS Code settings, dotfiles, SSH config, etc.)
- Snapshots are saved to your chosen destination in a `RestoreBackup` folder
- Unchanged files are hardlinked between snapshots (Time Machine style)
- Old snapshots are auto-pruned (default: keep 14)

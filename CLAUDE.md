# CLAUDE.md

Backup CLI — TypeScript CLI tool that saves important files to iCloud (or other destinations).

## Project Goal

`restore` is a CLI that:
1. Reads a config specifying which files/dirs to back up
2. Copies/syncs them to a target location (default: iCloud Drive)
3. Can restore files from backup on demand

## Tech Stack

- **Runtime:** Node.js (>=20)
- **Language:** TypeScript, strict mode
- **CLI framework:** `commander`
- **Interactive prompts:** `@clack/prompts`
- **Config format:** JSON5 (`~/.config/restore/config.json5`)
- **Sync engine:** snapshot-based with hardlinks (Time Machine style), `fs.cp` with checksum
- **Testing:** Vitest
- **Linting:** biome

## Commands (once set up)

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Dev (watch mode)
pnpm dev

# Run CLI in dev mode
pnpm start -- backup
pnpm start -- restore

# Test
pnpm test
pnpm test -- --watch    # watch mode

# Lint & format
pnpm lint
pnpm format
```

## CLI Commands

| Command | Description |
|---|---|
| `restore config` | Interactive wizard — first-run auto-launches if no config |
| `restore backup [--dry-run]` | Run backup to the configured destination |
| `restore restore [--snapshot <id>]` | Restore files from a snapshot |
| `restore daemon start` | Start background daemon (interval-based auto backup) |
| `restore daemon stop` | Stop background daemon |
| `restore plugin list` | Show installed plugins |
| `restore plugin add <name>` | Install a plugin from the curated list |

## Design Decisions (confirmed)

- **Source system:** Plugin-based — each plugin is a JSON file (`name`, `description`, `paths`) describing what to back up. Users don't manually type paths.
- **Plugin management:** Built-in curated list. `restore plugin add <name>` installs from it. Plugins live in `~/.config/restore/plugins/`.
- **Destination:** Single global backup destination (name + path + type). All plugins share one destination.
- **Versioning:** Snapshot directories with hardlinks for unchanged files (Time Machine style). Max 14 snapshots (configurable), auto-prune oldest.
- **Auto backup:** Background daemon (`restore daemon start`), runs every 12 hours by default. Daemonizes to background.
- **Config format:** JSON5 (`~/.config/restore/config.json5`).
- **Encryption:** None. Files stored as-is.
- **First run:** Auto-launches config wizard when no config found.

## Architecture

```
~/.config/restore/
├── config.json5            # Global config (destination, plugins, daemon settings)
└── plugins/                # Plugin JSON files describing what to back up
    ├── vscode.json
    └── projects.json

~/Library/Mobile Documents/com~apple~CloudDocs/
└── restore/                # Default backup root
    ├── 2026-06-11T14.30.00/   # Snapshot dir (hardlinks for unchanged)
    ├── 2026-06-12T02.00.00/
    └── ...                 # Max 14 snapshots, auto-prune oldest
```

```
src/
├── cli/                    # CLI entry point, command definitions
│   ├── index.ts            # main() — parse args, dispatch
│   ├── config.ts           # `restore config` — interactive wizard
│   ├── backup.ts           # `restore backup` — run backup once
│   ├── restore.ts          # `restore restore` — restore from snapshot
│   ├── daemon.ts           # `restore daemon [start|stop]` — background daemon
│   └── plugin.ts           # `restore plugin [list|add]` — plugin management
├── config/                 # Config loading, validation, defaults
│   ├── loader.ts           # read ~/.config/restore/config.json5
│   ├── wizard.ts           # @clack/prompts interactive setup wizard
│   └── types.ts            # Config type definitions
├── engine/                 # Core sync logic
│   ├── snapshot.ts         # Create snapshot with hardlinks for unchanged
│   ├── prune.ts            # Prune old snapshots beyond max count
│   ├── diff.ts             # Determine what changed since last snapshot
│   └── restore.ts          # Restore files from a specific snapshot
├── plugin/                 # Plugin system
│   ├── registry.ts         # Built-in curated plugin list
│   ├── loader.ts           # Load & validate plugin JSON files
│   └── types.ts            # Plugin schema types
├── daemon/                 # Background daemon
│   ├── scheduler.ts        # Interval-based scheduling (every N hours)
│   └── lifecycle.ts        # start/stop/status management
├── util/                   # Logging, file hashing, shell wrappers
│   ├── log.ts              # Logging (stderr for errors, stdout for success)
│   ├── hash.ts             # File checksum utilities
│   └── fs.ts               # File system helpers (hardlinks, copy)
└── types.ts                # Shared types
```

## Conventions

- TypeScript strict mode
- No default exports — named exports only
- Async-first where I/O is involved
- Error messages go to stderr, success to stdout
- `--dry-run` flag on all destructive commands
- `--verbose` / `--quiet` log level flags

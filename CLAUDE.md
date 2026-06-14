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
| `restore-cli config` | Interactive wizard — first-run auto-launches if no config |
| `restore-cli backup [--dry-run]` | Run backup to the configured destination |
| `restore-cli restore [--snapshot <id>]` | Restore files from a snapshot |
| `restore-cli daemon start` | Start background daemon (interval-based auto backup) |
| `restore-cli daemon stop` | Stop background daemon |
| `restore-cli tool` | Run a plugin tool interactively |

## Design Decisions (confirmed)

- **Source system:** Plugin-based — built-in plugins describe what to back up. Enable/disable via `config.json5`.
- **Plugin management:** All plugins are embedded in restore-cli. Use `restore-cli config` to choose which ones to back up.
- **Destination:** Single global backup destination (name + path + type). All plugins share one destination.
- **Versioning:** Snapshot directories with hardlinks for unchanged files (Time Machine style). Max 14 snapshots (configurable), auto-prune oldest.
- **Auto backup:** Background daemon (`restore daemon start`), runs every 12 hours by default. Daemonizes to background.
- **Config format:** JSON5 (`~/.config/restore/config.json5`).
- **Encryption:** None. Files stored as-is.
- **First run:** Auto-launches config wizard when no config found.

## Architecture

```
~/.config/restore/
└── config.json5            # Global config (destination, enabled plugins, daemon settings)

~/Library/Mobile Documents/com~apple~CloudDocs/
└── restore/                # Default destination path (configurable)
    └── RestoreBackup/      # Snapshot root (auto-created)
        ├── 2026-06-11T14.30.00.123/   # Snapshot dir (hardlinks for unchanged)
        ├── 2026-06-12T02.00.00.456/
        └── ...             # Max 14 snapshots, auto-prune oldest
```

```
src/
├── cli/                    # CLI entry point, command definitions
│   ├── index.ts            # main() — parse args, dispatch
│   ├── config.ts           # `restore config` — interactive wizard
│   ├── backup.ts           # `restore backup` — run backup once
│   ├── restore.ts          # `restore restore` — restore from snapshot
│   └── daemon.ts           # `restore daemon [start|stop]` — background daemon
├── config/                 # Config loading, validation, defaults
│   ├── loader.ts           # read ~/.config/restore/config.json5
│   ├── wizard.ts           # @clack/prompts interactive setup wizard
│   └── types.ts            # Config type definitions
├── engine/                 # Core sync logic
│   ├── snapshot.ts         # Create snapshot with hardlinks for unchanged
│   ├── run-backup.ts       # Shared backup orchestration (CLI + daemon)
│   ├── prune.ts            # Prune old snapshots beyond max count
│   ├── diff.ts             # Determine what changed since last snapshot
│   └── restore.ts          # Restore files from a specific snapshot
├── plugin/                 # Plugin system
│   ├── registry.ts         # Built-in plugin definitions
│   ├── loader.ts           # Resolve enabled plugins from config
│   └── types.ts            # Plugin schema types
├── daemon/                 # Background daemon
│   ├── scheduler.ts        # Interval-based scheduling (every N hours)
│   ├── worker.ts           # Detached worker process that runs backups
│   └── lifecycle.ts        # start/stop/status management
├── util/                   # Logging, file hashing, shell wrappers
│   ├── log.ts              # Logging (stderr for errors, stdout for success)
│   ├── path.ts             # Path expansion and backup root helpers
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

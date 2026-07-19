# @ssbun/restore-cli 1.0.0

Apple Silicon macOS recovery CLI. Supports macOS 26, 15, and 14. Intel Macs and older systems are rejected.

## Install

```bash
npm install -g @ssbun/restore-cli
restore-cli config
```

The default recovery restores configuration files only and reports missing applications. It never installs apps implicitly.

## Core workflow

```bash
restore-cli repository init /Volumes/Backup --recovery-file ~/restore-recovery.txt
restore-cli backup
restore-cli status
restore-cli verify --content
restore-cli recover --repository /Volumes/Backup/RestoreBackup --repository-id <id> --protection encrypted --recovery-file ~/restore-recovery.txt --staging-root ~/RestoreStaging --json
restore-cli apply --staging-root ~/RestoreStaging --execute
```

Recovery is staged and dry-run by default. Review the plan, then explicitly apply it. A safety point is created before writes; rollback is explicit. App Store, DMG, Raycast, and unknown applications are reported as manual steps. Homebrew and VS Code installers require an approved plan, phase confirmation, and `--execute-install`.

Use `--json` for machine-readable stdout. Use `--non-interactive` in automation; it refuses configuration wizards and risky commands without explicit flags. Errors go to stderr with stable exit codes.

## Scheduler

```bash
restore-cli daemon start
restore-cli daemon status
restore-cli daemon stop
```

The default interval is 12 hours; `0` disables scheduling. The scheduler performs backups only—never restore, migration, installation, or destructive retention maintenance.

See [offline recovery checklist](docs/recovery/offline-checklist.md) for a clean-machine runbook.

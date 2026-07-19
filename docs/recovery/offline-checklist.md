# Offline recovery checklist

1. Confirm Apple Silicon and a supported macOS version; connect the repository target.
2. Keep the independent recovery credential outside `RestoreBackup`.
3. Run `repository inspect` and `verify --content`; stop on identity, integrity, or protection errors.
4. Run `recover` without installer flags. Review the staged plan and missing-application report.
5. Apply only after review and explicit consent. Keep the generated safety point.
6. Verify restored configuration and rerun `status`/`verify --content`.
7. Install reported applications manually, or use only the explicitly approved Homebrew/VS Code phases.
8. Start the scheduler after recovery; it performs backups only.

All destructive operations support dry-run. Never delete the last healthy recovery point.

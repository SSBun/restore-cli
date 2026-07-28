# 为每次备份显示系统通知

## 状态

- [x] 已完成

## 目标

- [x] 手动实际备份结束后显示一次包含结果的 macOS 通知。
- [x] 定时实际备份无论成功、partial 或失败都显示通知。
- [x] `backup --dry-run` 不显示通知，通知失败不改变备份结果或退出码。

## 计划

- [x] 复用现有 `sendLocalNotification`，增加共享的备份结果通知格式。
- [x] 接入手动 CLI 与 scheduler，并补最小测试。
- [x] 运行相关测试、质量门禁和独立对抗审查。

## Review status

- Gate: APPROVED
- State: APPROVED
- Reviewer: `backup-notification-reviewer`
- Round: INITIAL (1)
- Scope: `src/cli/backup.ts`、`src/scheduler/notification.ts`、`src/scheduler/run.ts` 及对应测试
- Summary: 手动与定时备份通知覆盖完整，dry-run 和通知失败边界保持不变。
- Unresolved: none
- Report: [Adversarial review report](../../reports/adversarial-review/backup-execution-notifications.md)

## 验证结果

- 测试先证明旧实现不会通知手动成功备份和定时成功备份。
- 定向测试通过：3 个文件、11 个测试。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 通过。
- 沙箱外全量 `pnpm test` 通过：55 个文件、437 个测试。

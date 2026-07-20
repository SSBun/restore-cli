# 修复 iCloud 锁身份误判

## 状态

- [x] 已完成

## 目标

- [x] iCloud/macOS 只改变 `owner.json` 的 `ctime` 时，锁仍可校验和释放。
- [x] 锁文件被替换或锁元数据被篡改时，仍返回 `LOCK_OWNERSHIP_CHANGED`。
- [x] 清理现有孤儿锁，并用真实 `backup --dry-run` 验证修复。

## 计划

- [x] 先补 `ctime` 单独变化的失败回归测试。
- [x] 从稳定文件身份比较中移除 `ctime`，不改变其他锁语义。
- [x] 运行相关测试、质量门禁和真实 dry-run。
- [x] 完成独立对抗审查。

## Review status

- Gate: APPROVED
- State: APPROVED
- Reviewer: `icloud-lock-reviewer`
- Round: RE-REVIEW (2)
- Scope: `src/repository/lock.ts`、`tests/repository/lock.test.ts`
- Summary: RE-REVIEW (2) 批准；R1 已关闭。
- Unresolved: none
- Report: [fix-icloud-lock-ctime.md](../../reports/adversarial-review/fix-icloud-lock-ctime.md)

## 验证结果

- 回归测试先在旧实现上仅新增用例失败，修复后 `tests/repository/lock.test.ts` 7/7 通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 通过。
- 全量 `pnpm test` 通过：55 个文件、436 个测试。
- 已安全清除精确匹配且 owner PID 不存在的孤儿锁 `bfd5e4a6-1aaa-4843-acd5-34e55e18c393`。
- 真实 `backup --dry-run` 不再出现锁错误，结束后仓库状态为 `unlocked`；退出码 3 仅来自既有缺失来源和一致性组问题。

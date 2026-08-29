# 解释 restore 命令的行为

Status: Completed (2026-08-28 21:39)
Kind: Task

## Target
- [x] T1: 基于当前 CLI 与实现，说明 restore 命令会读取什么、产生什么、不会直接改变什么，以及后续 apply/rollback 的安全边界

## Plan

1. 核对 `restore` 的恢复点选择、验证、暂存与输出行为。
2. 区分暂存、显式应用与回滚对真实路径的影响。

## Result

- T1: restore-cli restore --help 与当前实现一致：restore 认证并验证恢复点后只写隔离 staging；默认选最新健康点，partial 需固定 point ID 和显式接受；apply/rollback 默认仅生成计划，--execute 才改变真实目标，并由 Safety Point 支持回滚。
- Review gate: Skipped — 用户未要求独立审查。

## Verification

- Passed: 已交叉核对当前 CLI help、README 安全恢复模型、restore 命令层以及 stage/apply 实现；观察到的输入、输出与安全边界一致。

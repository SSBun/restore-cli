# 为 backup 添加进度提示

Status: Completed (2026-08-28 22:04)
Kind: Task

## Target
- [x] T1: 运行交互式人类可读 backup 时，在来源清单之后持续显示当前准备、捕获、写入和验证阶段，避免长时间无反馈
- [x] T2: 进度信息不破坏最终结果、JSON stdout 契约、quiet 行为或调度备份行为

## Plan

1. 复用现有终端进度模块，提供可更新且必定清理的阶段指示器。
2. 将手动 backup 的插件准备、来源捕获、写入、验证和发布阶段接入指示器。
3. 增加最小回归检查，并运行允许的类型、lint 与构建验证。

## Result

- T1: 已构建并通过伪 TTY 运行实际 restore-cli --json backup --dry-run：来源清单后出现 Capturing sources 阶段，13 秒捕获期间记录到 211 次 spinner 刷新；非 dry-run 代码同时接入插件准备、逐文件写入、回读验证、发布和同步阶段。
- T2: 伪 TTY 的 --quiet --json dry-run 中进度文本完全隐藏且 JSON 结果仍存在；进度仅由手动 backup CLI 注入并写 stderr，调度器路径未变。
- Review gate: Skipped — 用户未要求独立审查。

## Verification

- Passed: tsc --noEmit、Biome changed-file check、git diff --check 与直接构建均通过；已验证构建后的全局 restore-cli TTY spinner、JSON 结果和 quiet 抑制。按用户规则未运行单元测试。

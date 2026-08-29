# 将 backup 来源显示为结构化表格

Status: Completed (2026-08-28 23:06)
Kind: Task

## Target
- [x] T1: restore-cli backup 的实际终端输出将来源清单显示为清晰的结构化表格，并保留插件分组、来源属性和完整路径信息
- [x] T2: 表格在不同内容长度下保持对齐，且不改变备份行为或最终 JSON 结果契约

## Plan

1. 将嵌套来源列表改为按插件分组的 Unicode 结构表格。
2. 根据可见文本动态计算列宽，保留完整 Contract 与路径。
3. 增加最小格式回归检查，并验证构建后的实际 dry-run 输出。

## Result

- T1: 构建后的实际 restore-cli --json backup --dry-run 已将 17 个来源输出为按插件分组的 Unicode 表格；每个来源包含 Contract 与完整缩短路径，插件内多来源使用结构分隔线。
- T2: 当前实际表格共 54 个结构行，去除 ANSI 后全部严格为 100 列；命令退出 0、最终 JSON state=success 且 issues=0，备份逻辑未改。
- Review gate: Skipped — 用户未要求独立审查。

## Verification

- Passed: tsc --noEmit、Biome changed-file check、git diff --check、直接构建及构建后全局 CLI dry-run 均通过；按用户规则未运行单元测试。

# 忽略缺失的可选配置来源

Status: Completed (2026-08-28 22:57)
Kind: Task

## Target
- [x] T1: backup 仅同步当前存在的配置；缺失的 optional 来源既不生成问题，也不把恢复点或一致性组降级为 partial
- [x] T2: 缺失的 required 来源仍阻止健康备份，读取失败或不稳定来源仍按现有安全规则报告
- [x] T3: 当前配置下 dry-run 不再因 git 与 VS Code 的可选缺失文件产生五条问题

## Plan

1. 将缺失的 optional 来源保留为清单状态，但从问题和一致性组失败判定中排除。
2. 保持 required 缺失及 optional 读取失败、不稳定的现有安全语义。
3. 更新直接相关的备份与状态回归检查，并验证当前 dry-run 输出。

## Result

- T1: capture 现在将 optional+missing 保留为非问题状态，并从一致性组失败判定中排除；存在的来源仍正常捕获，生成清单可保持 healthy。
- T2: required+missing 分支仍生成 failure 且 requiredFailed 判定未变；optional 的 unreadable/unstable 分支及 partial 严重度未修改，并保留对应回归检查。
- T3: 构建后的实际 restore-cli --json backup --dry-run 在当前配置上退出 0，state/category 均为 success，issues 为空；三个 optional 缺失来源仅计为 skipped。
- Review gate: Skipped — 用户未要求独立审查。

## Verification

- Passed: tsc --noEmit、Biome changed-file check、git diff --check 和直接构建通过；构建后的全局 CLI dry-run 实测 success/0 issues。按用户规则未运行单元测试。

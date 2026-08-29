# 诊断 backup 长时间停顿

Status: Completed (2026-08-28 21:49)
Kind: Task

## Target
- [x] T1: 在不写入备份仓库的前提下定位 backup 在来源清单和明文警告后长时间无输出的阶段，说明耗时原因并判断是正常等待还是缺陷

## Plan

1. 分别计时动态插件准备和 `backup --dry-run` 来源捕获。
2. 对照调用顺序定位无输出区间及最慢操作。
3. 判断实际工作是否正常，并区分性能问题与进度展示缺陷。

## Result

- T1: 无仓库写入的实测显示：插件准备 3.937 秒（Homebrew 3.025 秒），backup --dry-run 13.457 秒，其中 csl-agent-kit 捕获 10.774 秒；同一备份流水线最近 20 次记录中位数 70.239 秒。源码确认 CLI 在警告后未连接已有进度回调，随后串行执行逐项元数据子进程、iCloud blob 写入/fsync 及逐 blob 回读验证。
- Review gate: Skipped — 用户未要求独立审查。

## Verification

- Passed: 独立计时插件准备、分来源 capture 与完整 dry-run，结果之和一致；Brewfile 记录 Homebrew auto-update 超时，历史耗时与串行 iCloud 写入和回读代码路径吻合。

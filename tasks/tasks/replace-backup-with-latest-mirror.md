# 将备份改为最新严格镜像

Status: Completed (2026-08-29 08:23)
Kind: Task

## Scope

- 包含：以当前配置来源为准的明文严格镜像、可读清单、五个命令的简化 CLI、旧仓库删除与首次重建。
- 不包含：历史版本、blob/envelope、加密、调度、恢复点兼容或旧命令兼容层。

## Target
- [x] T1: backup 只维护一份人类可读的当前文件严格镜像，不再创建新的恢复点历史；本地来源删除后镜像中的对应内容也删除
- [x] T2: 删除现有恢复点仓库及全部历史，并从当前本地来源重建最新镜像
- [x] T3: CLI 仅保留 `config`、`backup`、`status`、`restore` 和 `open`，移除恢复点、verify、dump、apply、rollback、repository、recover、daemon 与 tool 命令
- [x] T4: `restore` 先比较镜像与原路径并展示差异，得到用户明确确认后才把所选差异恢复到原路径；确认前不修改原路径
- [x] T5: restore diff 包含本地新增、缺失和内容变化；确认执行后创建、覆盖并删除对应项，使原路径严格匹配镜像
- [x] T6: backup 保留 `--dry-run`；非交互 restore 必须显式执行，镜像和原路径不会因未确认操作而改变
- [x] T7: `open` 在 Finder 中打开配置的同步存储目录，而不是其 `RestoreBackup` 镜像子目录

## Decisions

- 仅保留最新同步副本，并采用严格镜像删除语义。
- 删除现有仓库后从当前本地文件重建，不迁移历史。
- restore 以整批 diff 为确认单位，执行后原路径严格匹配镜像。

## Plan

1. 将配置模型和命令注册缩减为 destination、plugins 与五个命令。
2. 实现可读镜像清单、流式复制、哈希比较和同目录临时树发布。
3. 将 backup、status、restore、open 接入镜像模型，并提供结构化 diff 与确认流程。
4. 更新直接相关文档和回归检查，完成类型、lint、构建和无写入行为验证。
5. 在独立破坏性确认后删除旧仓库，运行首次镜像 backup 并验证实际数据。

## Result

- T1: 实际 RestoreBackup 已改为可直接浏览的 plugin/source 严格镜像；manifest 记录 17 个来源和 48 个稳定文件，backup --dry-run 当前 wouldChange=false。
- T2: 经用户破坏性确认后，69 个旧恢复点（约 64 MB）和 63 条调度历史已删除；旧 points、repository.json、调度目录及 LaunchAgent 均不存在。
- T3: 构建后的 restore-cli --help 只列出 config、backup、status、restore、open；旧命令实现、调度/仓库/恢复点模块与对应测试共删除约 3.4 万行。
- T4: 隔离 HOME 端到端 smoke 显示 restore --dry-run 先返回 create=1、modify=1、delete=1；未执行前源文件保持测试中的主动改动，执行路径要求交互确认或 --execute。
- T5: 隔离 HOME 非交互 restore --execute 后，修改文件恢复原内容、缺失文件重建、本地额外文件删除，随后 status drift=0。
- T6: 实际 backup --dry-run、restore --dry-run 与 status 均退出 0 且无写入差异；--quiet 的 stderr 为 0，非交互 restore 无 --execute 会被拒绝，镜像更新在同步目录外构建验证后原位发布。
- T7: 构建后的 restore-cli open 实际输出 Opening /Users/caishilin/Library/Mobile Documents/com~apple~CloudDocs，并在 Finder 中打开配置的 destination.path；help 文案同步改为 configured sync storage。
- Review gate: Skipped — 用户未要求独立审查。

## Verification

- Passed: tsc --noEmit、Biome open.ts、git diff --check、直接构建、open --help 与实际 restore-cli open 均通过；按用户规则未运行单元测试。

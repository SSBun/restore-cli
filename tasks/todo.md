# 项目审计待办

## [阻止重叠插件导致配置向导崩溃](todo/prevent-config-plugin-overlap-crash.md)

- 状态：Completed (2026-07-28 14:21)

## [修复 iCloud 锁身份误判](todo/fix-icloud-lock-ctime.md)（2026-07-20）

- 状态：已完成
- 目标：允许同步服务只改变锁文件 `ctime`，同时保留对锁替换和内容篡改的拒绝。
- 审查报告：[fix-icloud-lock-ctime.md](../reports/adversarial-review/fix-icloud-lock-ctime.md)

## 诊断 iCloud 仓库锁失败（2026-07-20）

### 状态

- [x] 已完成

### 目标

- [x] 判断 `REPOSITORY_LOCKED` 是真实并发备份还是孤儿锁。
- [x] 定位此前 `LOCK_OWNERSHIP_CHANGED` 与锁未释放的原因，不修改仓库。

### 诊断结果

- 锁记录的备份 PID `76580` 已不存在，当前是孤儿锁，不是活跃备份。
- 锁创建于 11:08:01；`owner.json` 的 ctime 在 11:08:04 改变，并带有 `com.apple.provenance` xattr。
- 锁身份检查比较 `ctime`；iCloud/macOS 的异步 provenance 更新因此被判定为锁身份变化。
- 第一次备份随后拒绝继续并拒绝释放被视为已变化的锁，后续备份因锁目录仍存在而返回 `REPOSITORY_LOCKED`。
- 当前只读诊断未清除或修改锁文件。

## 改善备份命令的人类可读输出（2026-07-20）

### 状态

- [x] 已完成

### 目标

- [x] `restore-cli backup` 的来源清单按插件分组、缩进并使用颜色区分信息层级。
- [x] 最终结果清楚突出成功/失败状态、身份信息、计数和问题列表。
- [x] `--json` 和退出码契约保持不变，不修改备份或锁业务逻辑。

### 计划

- [x] 复用现有 ANSI color helper，在现有格式化层实现最小输出改动。
- [x] 补来源清单和最终失败结果的最小格式测试。
- [x] 运行相关测试、typecheck、lint、build 和全量测试。
- [x] 完成独立对抗审查。

### Review status

- Gate: APPROVED
- Reviewer: `/root/backup_output_reviewer`
- Round: 2/3
- Scope: `src/cli/backup.ts`、`src/cli/backup-format.ts`、`src/util/result.ts` 及对应测试
- Resolved: R1、R2、R3、R4
- Unresolved: none

### 验证结果

- 相关测试通过：3 个文件、19 个测试。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 通过。
- 沙箱外全量 `pnpm test` 通过：55 个文件、435 个测试。
- 真实 `backup --dry-run` 已显示彩色分组、缩进和结构化失败结果；未写入仓库。

## 诊断 iCloud 备份目标初始化失败（2026-07-20）

### 状态

- [x] 已完成

### 目标

- [x] 定位 `restore-cli config` 在 iCloud 目录初始化仓库失败的实际原因。
- [x] 用代码、测试或可复现命令验证原因，不修改业务代码。

### 计划

- [x] 跟踪配置向导到仓库初始化的完整调用链和错误映射。
- [x] 检查 iCloud 路径特性与仓库目标校验约束。
- [x] 运行最小复现或相关测试，记录诊断证据。

### 诊断结果

- 当前配置目标是 iCloud Drive 根目录，配置中没有 v1 `repository` 字段。
- 该目标下已经存在旧版 `RestoreBackup`，包含 `.restore-marker` 和一个旧快照。
- iCloud 目标只读预检成功，能取得稳定卷 UUID 和可用容量；路径本身不是阻塞点。
- v1 初始化固定创建 `<destination>/RestoreBackup`，遇到现存同名目录会返回 `REPOSITORY_PATH_OCCUPIED`，拒绝覆盖旧备份。
- 配置向导用无绑定 `catch` 隐藏了错误码和详细消息，只显示统一初始化失败文案。

### 验证结果

- `pnpm vitest run src/config/wizard.test.ts src/config/wizard-flow.test.ts` 通过：2 个文件、9 个测试。
- 沙箱外只读 `preflightTarget(..., { intent: 'read' })` 通过，稳定卷标识为有效 `volume:` UUID。
- 未修改业务代码，未改动或删除现有 iCloud 备份。

## 简化配置流程（2026-07-19）

### 状态

- [x] 已完成

### 目标

- [x] 用户选择备份目标后自动创建明文 v1 仓库并保存仓库 ID。
- [x] 新用户不再手工运行 `repository init` 或编辑 JSON5。
- [x] 配置流程明确警告仓库内容未加密，且初始化失败时不写入无效配置。

### 计划

- [x] 对照旧配置向导与当前 v1 仓库约束。
- [x] 补自动初始化和失败原子性的最小测试。
- [x] 实现配置向导并同步 README/使用指南。
- [x] 运行质量门禁和独立对抗审查。

### Review status

- Gate: APPROVED
- Reviewer: `/root/config_flow_open_reviewer`（替代 Reviewer）
- Round: 5/OPEN
- Scope: `src/config/wizard.ts`、`src/config/wizard.test.ts`、`README.md`、`docs/usage-guide.md`
- Resolved: R1、R2、R3、R4、R5、R6、R7
- Unresolved: none

### 验证结果

- 配置相关测试通过：3 个文件，12 个测试。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 通过。
- 批准后在沙箱外运行 `pnpm test`，退出码为 0。

## README 与使用指南（2026-07-19）

### 状态

- [x] 已完成

### 目标

- [x] README 准确说明安装要求、核心能力、快速开始和安全恢复流程。
- [x] 新增中文使用指南，覆盖配置、仓库、备份、验证、恢复、调度和自动化。
- [x] 文档中的命令与当前 CLI 参数一致，链接有效。

### 计划

- [x] 核对 `package.json`、CLI 注册代码和现有 README。
- [x] 更新 README 并新增使用指南。
- [x] 验证命令帮助、文档链接和项目质量门禁。
- [x] 完成独立对抗审查并记录结果。

### Review status

- Gate: APPROVED
- Reviewer: `/root/config_flow_open_reviewer`（替代 Reviewer，完整复审文档）
- Round: 5/OPEN
- Scope: `README.md`、`docs/usage-guide.md`
- Resolved: R1、R2、R3、R4、R5、R6、R7
- Unresolved: none

### 验证结果

- `git diff --check` 通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。
- `pnpm test` 在沙箱外通过；沙箱内因文件系统身份检查受限而误报 `TARGET_INSPECTION_FAILED`。
- `node dist/index.js --help`、`apply --help`、`recover --help` 已核对。
- 开放审查第 5 轮通过，最终 verdict 为 `APPROVED`。

## 假设

- 本次任务是快速产品/工程审计，不改业务代码。
- 下一版本功能列表优先选择能提高 CLI 可用性、可靠性和发布质量的最小闭环。
- 现有 `package.json` 有未提交改动，审计只读取，不覆盖。

## 计划

- [x] 记录审计计划。
- [x] 扫描项目结构、核心命令、配置、插件、备份/恢复、守护进程流程。
- [x] 检查测试、构建、lint 状态。
- [x] 输出主要风险、缺口和下一版本功能建议。

## 审计结果

### 当前功能

- `restore-cli config`：交互式配置备份目标、自动备份间隔、最大快照数、启用插件。
- `restore-cli backup`：按已启用插件生成快照，支持 `--dry-run`，未变化文件使用硬链接。
- `restore-cli restore --list` / `restore-cli restore`：列出快照并交互式覆盖恢复。
- `restore-cli tool`：运行内置插件工具。
- `restore-cli daemon start|stop|status`：用 fork worker 和 PID 文件实现定时备份。
- 内置插件：`vscode`、`vscode-extensions`、`dotfiles`、`ssh`、`zsh`、`git`、`iterm2`、`vim`、`mac-apps`。

### 主要风险

- P0：快照写入不是原子提交，失败后可能留下被后续 `latest/restore` 识别的半成品快照。
- P0：`restore` 快照列表没有复用合法快照名过滤规则，可能列出非快照目录。
- P0：配置向导允许 daemon interval 为 `0`，但 schema 要求正数，配置会在下次读取时失败并回退默认值。
- P1：daemon PID 只验证 PID 存在，PID 复用时 `stop` 可能杀错进程；worker 也没有运行中锁。
- P1：恢复只能直接覆盖，没有 dry-run、按插件选择、恢复到目录、失败汇总。
- P1：备份会静默跳过不可访问/消失的路径，容易出现“成功但漏备份”。
- P2：`backup --dry-run` 仍会执行 `preparePlugins`，`mac-apps` 会写 inventory 文件，语义不纯。
- P2：diff 只用 size + mtime，mtime 被保留或回拨时可能漏检内容变更。

### 下一版本建议

1. 快照提交协议：写入 `timestamp.in-progress`，全部复制和校验完成后 rename 为正式快照；`latest/list/prune/restore` 只认完整快照。
2. 安全恢复：增加 `restore --dry-run`、`restore --plugin <name>`、`restore --to <dir>`，先输出逐文件计划，再允许覆盖。
3. 配置与 daemon 修复：修正 `0` 禁用规则，增加 `config show/path/validate`，让 `daemon status` 显示 PID、interval、上次运行结果。
4. daemon 可靠性：PID 文件加入进程身份校验，`tick` 加运行中保护，避免重叠备份和误杀。
5. 可观测备份：把 skipped paths 和原因纳入 backup result，CLI/daemon 明确显示 warning。
6. 质量门禁：让测试代码也参与 typecheck/lint，重写 prune、daemon、restore 安全边界测试。
7. `mac-apps` 恢复助手：新增缺失应用对比和 install plan 输出；先不要做自动安装。

### 验证

- `pnpm build` 通过。
- `pnpm test` 通过：10 个 test files，40 个 tests。
- `pnpm lint` 通过。

## 多 Agent 分发

### 分发假设

- 目标是实现下一版本建议中的最小可用版本，不引入新依赖。
- 每个 worker 只改自己负责的文件；主线程负责最终集成和验证。
- 已有 `package.json` 未提交改动不是本次审计产生的，worker 不应覆盖。

### Worker 任务

- [x] Worker A：快照提交协议与统一快照识别。
  - 范围：`src/engine/snapshot.ts`、`src/engine/prune.ts`、`src/engine/restore.ts` 中快照列表相关逻辑、对应测试。
  - 成功条件：半成品快照不会被 latest/list/prune/restore 识别；prune 按快照名时间排序。
  - 执行计划：
    - [x] 补最小测试：半成品目录不出现在 latest/list/restore 信息中。
    - [x] 补最小测试：prune 只删除合法完整快照里的旧快照，并按快照名称时间排序。
    - [x] 在 `snapshot.ts` 集中合法完整快照识别与名称时间排序。
    - [x] 让 `createSnapshot` 先写 `.in-progress` 临时目录，完成后 rename 为正式快照。
    - [x] 让 prune/restore 列表入口复用同一识别规则。
    - [x] 运行相关测试并记录结果。
  - 执行结果：
    - `createSnapshot` 现在写入 `timestamp.in-progress`，复制和校验完成后 rename 到正式 `timestamp` 目录。
    - `getLatestSnapshotDir`、`listSnapshots`、`getSnapshotInfo` 复用 `listCompleteSnapshots`，只识别合法时间戳目录。
    - `pruneSnapshots` 通过合法快照名的字典序保留新快照，不再依赖 birthtime。
  - 验证：
    - `pnpm vitest run tests/integration/backup-restore.test.ts` 通过。
    - `pnpm build` 通过。
    - `pnpm exec biome check src/engine/snapshot.ts src/engine/prune.ts src/engine/restore.ts tests/integration/backup-restore.test.ts` 通过。
    - `pnpm test` 未全量通过，失败集中在 `mac-apps` 恢复助手/工具脚本测试，非 Worker A 范围。
- [x] Worker B：配置与 daemon 最小修复。
  - 范围：`src/config/*`、`src/cli/config.ts`、`src/cli/daemon.ts`、`src/daemon/*`、对应测试。
  - 成功条件：interval `0` 合法表达禁用；`config show/path/validate` 可用；daemon 不重叠执行。
  - 本轮执行计划：
    - [x] 补测试覆盖 interval `0` schema、配置校验、daemon start 禁用提示、worker tick 防重入、stale/非 daemon PID。
    - [x] 调整配置 schema/向导文案，并增加 `config show/path/validate`。
    - [x] 调整 daemon start、worker tick 运行中保护、PID 文件兼容与安全判断。
    - [x] 运行相关测试、构建/检查，并记录结果。
  - 执行结果：
    - `daemon.intervalHours` 允许 `0`；向导明确提示 `0` 会禁用后台 daemon。
    - 新增 `config show`、`config path`、`config validate`，其中 `validate` 严格校验配置文件，不走 `loadConfig` 的默认回退。
    - `daemon start` 遇到 interval `0` 输出禁用提示并返回，不 fork worker。
    - worker tick 增加运行中保护，上一轮备份未完成时跳过下一次 tick。
    - PID 文件新写入 `{ pid, owner }` JSON，同时兼容旧数字 PID；stale PID 和非 restore worker 的 live PID 会被清理，`stop` 不再直接杀非 daemon 进程。
  - 验证：
    - `pnpm test src/config/types.test.ts src/daemon/tick.test.ts tests/integration/config-command.test.ts tests/integration/daemon-command.test.ts tests/integration/daemon-lifecycle.test.ts` 通过。
    - `pnpm test` 通过。
    - `pnpm build` 通过。
    - `pnpm exec biome check src/config/types.ts src/config/loader.ts src/config/wizard.ts src/cli/config.ts src/cli/daemon.ts src/daemon/lifecycle.ts src/daemon/scheduler.ts src/daemon/worker.ts src/daemon/tick.ts src/config/types.test.ts src/daemon/tick.test.ts tests/integration/config-command.test.ts tests/integration/daemon-command.test.ts tests/integration/daemon-lifecycle.test.ts` 通过。
    - `pnpm lint` 通过。
    - `pnpm typecheck` 通过。
- [x] Worker C：备份 skipped paths 可观测性与 dry-run 语义。
  - 范围：`src/engine/diff.ts`、`src/engine/run-backup.ts`、`src/cli/backup.ts`、`src/cli/backup-format.ts`、对应测试。
  - 成功条件：不可访问/缺失路径出现在 warning；`backup --dry-run` 不写 plugin prepare 产物。
  - 执行计划：
    - [x] 补最小失败测试：缺失 source path 会进入 skipped paths。
    - [x] 补最小失败测试：`runBackup(..., { dryRun: true })` 不生成 plugin prepare 产物。
    - [x] 补最小失败测试：CLI 格式化 skipped paths 为 warning。
    - [x] 在 diff/backup plan 中透传 skipped path 与原因。
    - [x] 让 CLI dry-run 规划时跳过 plugin prepare；普通 backup 保持 prepare。
    - [x] 运行相关测试并记录结果。
  - 复核结果：
    - `diffWithLastSnapshotDetailed` 返回 `diffs` 和 `skipped`；旧 `diffWithLastSnapshot` 保持数组返回，避免影响 snapshot 调用。
    - `prepareAndPlan`、`runBackup` 和 CLI 现在透传 `skippedPaths`，CLI 用简短 `Warnings` 段落显示路径和原因。
    - `backup --dry-run` 规划时传入 `skipPrepare: true`；普通 backup 仍执行 plugin prepare。
    - 验证通过：`pnpm vitest run src/engine/diff.test.ts src/engine/run-backup.test.ts tests/unit/backup-format.test.ts`、`pnpm lint`、`pnpm build`、`pnpm test`。
- [x] Worker D：恢复安全 UX。
  - 范围：`src/cli/restore.ts`、`src/engine/restore.ts` 的恢复执行逻辑、对应测试。
  - 成功条件：支持 `restore --dry-run`、`--plugin <name>`、`--to <dir>`，恢复前可预览计划。
- [x] Worker E：质量门禁。
  - 范围：`package.json`、`tsconfig*.json`、`biome.json`、测试结构。
  - 成功条件：测试代码参与 typecheck/lint；现有测试通过。
  - 执行计划：
    - [x] 读取并保留 `package.json` 现有未提交改动。
    - [x] 拆分全量类型检查配置与构建产物配置，避免测试输出到 `dist`。
    - [x] 扩大 lint 覆盖到 `src` 与 `tests`。
    - [x] 运行 `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm lint` 并记录结果。
  - 验证结果：
    - Worker E 完成时，质量门禁已生效，但并发 worker 的中间状态仍有失败。
    - 主线程最终集成后，`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test` 均通过。
- [x] Worker F：`mac-apps` 恢复助手。
  - 范围：`src/plugin/mac-apps-inventory.ts`、`src/plugin/registry.ts`、`src/plugin/scripts/mac-apps/*`、`src/plugin/tools.ts`、对应测试。
  - 成功条件：能输出当前机器缺失 app 和安装计划；不自动安装。

## Worker F 执行计划

### 假设

- `mac-apps` 恢复助手作为插件工具运行，不改备份、恢复、daemon 核心流程。
- 当前机器扫描复用已有 `.app` inventory 结构；对比优先使用 `bundleId`，没有 `bundleId` 时退回 `path`。
- brew/mas 无法可靠自动映射，本次只输出 `manual` 手工安装计划，不执行安装命令。

### 计划

- [x] 先补失败测试：能从 expected/current inventory 中找出缺失 app，并生成手工安装计划。
- [x] 注册新的 `mac-apps` 工具脚本，确保工具发现逻辑能解析。
- [x] 在 `mac-apps-inventory.ts` 增加最小比较和计划函数，保持现有 inventory 生成行为不变。
- [x] 新增薄 shell 脚本输出缺失应用和手工安装计划，不自动安装。
- [x] 运行相关测试、build、脚本语法验证，并记录结果。

### Worker F 结果

- 新增 `restore-plan` 工具：读取 `~/.config/restore/inventory/mac-apps.json`，扫描当前机器，输出缺失应用和 `manual` 安装计划。
- 对比规则：优先用 `bundleId`，无 `bundleId` 时使用 `path`；不推断 brew/mas，不执行安装命令。
- 验证通过：
  - `pnpm test src/plugin/mac-apps-inventory.test.ts tests/unit/plugin-tools.test.ts tests/integration/plugin.test.ts`
  - `pnpm exec biome check src/plugin/mac-apps-inventory.ts src/plugin/mac-apps-inventory.test.ts src/plugin/registry.ts src/plugin/tools.ts tests/unit/plugin-tools.test.ts`
  - `pnpm exec tsc --noEmit --pretty false --module NodeNext --moduleResolution NodeNext --target ES2022 --strict --types node,vitest src/plugin/mac-apps-inventory.ts src/plugin/mac-apps-inventory.test.ts tests/unit/plugin-tools.test.ts tests/integration/plugin.test.ts`
  - `bash -n src/plugin/scripts/mac-apps/restore-plan.sh src/plugin/scripts/mac-apps/list.sh src/plugin/scripts/mac-apps/refresh.sh src/plugin/scripts/mac-apps/open-inventory.sh`
- 全量验证状态：
  - `pnpm test` 当前失败，失败点来自其他 Worker 范围的未完成测试/改动：`backup-format`、`config-command`、daemon、`run-backup`、`diff`、`config/types` 等。
  - `pnpm build` 当前失败，阻塞点为 `src/daemon/lifecycle.ts` 中 `parsed.pid` 可能为 `undefined`，不属于 Worker F 范围。
  - `pnpm lint` 当前失败，除本次已修复的 Worker F 文件外，还有其他测试文件的 import/format 问题。

## Worker D 执行计划

### 假设

- `restore --plugin <name>` 只允许恢复当前配置中已启用且可识别的插件路径；未知或未启用插件应报错退出。
- `restore --to <dir>` 不写回原位置，而是把快照中的绝对路径结构放到目标目录下，例如 `/Users/me/.zshrc` 写到 `<dir>/Users/me/.zshrc`。
- `restore --dry-run` 只输出计划，不创建目录、不复制文件，也不需要覆盖确认。
- 默认无 `--dry-run` 且无 `--to` 时继续保留交互确认覆盖逻辑。

### 计划

- [x] 检查现有恢复引擎和 CLI 调用边界，避开快照列表逻辑。
- [x] 为恢复引擎增加可复用的恢复计划，支持 dry-run 和目标目录映射。
- [x] 为 CLI 增加 `--dry-run`、`--plugin <name>`、`--to <dir>`，并输出计划。
- [x] 补最少测试覆盖 dry-run、plugin 过滤、to 目录恢复。
- [x] 运行相关测试，记录结果和风险。

### Worker D 复盘

- 已改 `src/engine/restore.ts`：新增恢复计划接口，执行恢复时复用计划；支持按目标目录恢复。
- 已改 `src/cli/restore.ts`：新增 `--dry-run`、`--plugin <name>`、`--to <dir>`；恢复前输出逐文件计划；非 dry-run 继续交互确认。
- 已改 `tests/integration/backup-restore.test.ts`：覆盖计划不写文件、按指定根过滤、恢复到目标目录。
- 验证通过：`pnpm test tests/integration/backup-restore.test.ts`。
- 验证通过：`pnpm exec biome check src/cli/restore.ts src/engine/restore.ts tests/integration/backup-restore.test.ts`。
- 风险：`pnpm build` 当前失败在 `src/daemon/lifecycle.ts` 的 `parsed.pid` 类型错误，属于其它 worker 范围，未修改。
- 风险：`pnpm lint` 当前还有其它 worker 文件的格式/import 问题，Worker D 相关文件已单独通过 lint。

## 主线程最终集成

- [x] 收齐并关闭 Worker A-F。
- [x] 合并交叉改动：`restore.ts` 同时包含完整快照识别和恢复计划；`package.json` 保留原有 build 脚本清理逻辑并增加质量门禁。
- [x] 运行最终验证：
  - `pnpm typecheck` 通过。
  - `pnpm lint` 通过。
  - `pnpm build` 通过。
  - `pnpm test` 通过：15 个 test files，59 个 tests。

## `status` 命令

### 假设

- `status` 表示本工具视角下的备份状态，不尝试判断 iCloud/SMB 是否已经完成云端同步。
- 统计项优先使用本地快照目录可可靠得到的数据：最近快照时间、快照数量、最新快照大小、总备份大小、文件数、daemon 状态。

### 计划

- [x] 记录计划。
- [x] 复用现有快照、路径和 daemon 状态工具。
- [x] 新增 `restore-cli status` 命令。
- [x] 补最小测试。
- [x] 运行 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test`。

### 结果

- 新增 `restore-cli status`，输出 destination、backup root、daemon 状态、快照数量、最近备份时间、最近快照名、最新快照大小/文件数、总备份大小/文件数。
- 统计基于本地 `RestoreBackup` 快照目录，不判断 iCloud/SMB 云端同步完成度。
- 命令名从初始 `stat` 调整为完整名 `status`；未保留 `stat` alias。
- 验证通过：
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`
  - `pnpm test`：17 个 test files，62 个 tests。
  - `pnpm exec tsx src/index.ts --help` 显示 `status` 命令。
  - `pnpm start -- status` 可正常输出本地备份状态。

## Homebrew 与 Raycast 插件

### 假设

- Homebrew 插件负责生成并备份 `~/.config/restore/inventory/Brewfile`，不自动安装。
- Raycast 插件只备份 Raycast 配置目录，不做导入/恢复自动化。
- 不新增依赖；复用现有内置插件、prepare、tool 脚本模式。

### 计划

- [x] 记录计划。
- [ ] 检查现有插件 registry、prepare、tool 脚本模式。
- [x] 新增 Homebrew inventory 生成逻辑和工具脚本。
- [x] 新增 Raycast 插件定义。
- [x] 补最小测试。
- [x] 运行 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test`。

### 结果

- 新增 `homebrew` 插件：
  - 备份路径：`~/.config/restore/inventory/Brewfile`
  - prepare hook：`brew bundle dump --force --file <Brewfile>`
  - 工具：`refresh` 重新生成 Brewfile，`show` 打印已保存 Brewfile
  - 若本机没有 Homebrew 或 `brew bundle` 失败，会写入带错误说明的 fallback Brewfile，避免备份流程无产物。
- 新增 `raycast` 插件：
  - 备份路径：`~/Library/Application Support/com.raycast.macos`
  - 无自动恢复工具。
- 验证通过：
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`
  - `pnpm test`：18 个 test files，66 个 tests。
  - `bash -n src/plugin/scripts/homebrew/refresh.sh src/plugin/scripts/homebrew/show.sh`

## restore-cli 配置插件

### 假设

- 插件只备份 `~/.config/restore/config.json5`，不自动恢复或改写当前配置。
- 不需要 prepare hook 或工具脚本。

### 计划

- [x] 记录计划。
- [x] 新增 `restore-cli` 内置插件定义。
- [x] 补 registry 测试。
- [x] 运行 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test`。

### 结果

- 新增 `restore-cli` 插件，备份 `~/.config/restore/config.json5`。
- 验证通过：
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`
  - `pnpm test`：18 个 test files，67 个 tests。

## backup 变更列表输出收敛

### 假设

- `backup` 仍应显示有变更，但不需要列出所有文件。
- 最小改法是在格式化层限制显示数量，不改变备份计划或 dry-run 行为。

### 计划

- [x] 记录计划。
- [x] 限制 `Changes` 列表默认最多显示 20 条。
- [x] 更新格式化测试。
- [x] 运行相关测试和全量验证。

### 结果

- `Changes` 列表默认最多显示 20 条路径。
- 超出部分显示为 `... N more not shown`。
- 验证通过：
  - `pnpm vitest run tests/unit/backup-format.test.ts`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`
  - `pnpm test`：18 个 test files，68 个 tests。

## prune 失败与 Raycast 备份范围

### 假设

- 当前 `ENOTEMPTY` 来自清理旧快照阶段，不应让已经写好的新快照变成失败结果。
- Raycast 整个 `Application Support` 目录包含索引、活动数据库、WAL、telemetry 等高频变动文件，不适合全量备份。
- 最小修复：prune 尽量清理，失败时返回 warning；Raycast 插件先只备份用户扩展和偏好相关稳定文件。

### 计划

- [x] 记录计划。
- [ ] 检查 prune 和 Raycast 目录结构。
- [x] 修复 prune 对瞬时清理失败的处理。
- [x] 收窄 Raycast 插件路径。
- [x] 补测试并运行验证。

### 结果

- `vscode-extensions` 插件现在备份：
  - `~/.config/restore/inventory/vscode-extensions.txt`
- 新增 `vscode-extensions-list` prepare hook：运行 `code --list-extensions` 生成扩展 ID 清单。
- 不再备份 `~/.vscode/extensions` 目录，避免 39874 个文件逐个同步。
- 新增工具：
  - `vscode-extensions refresh`
  - `vscode-extensions show`
- 验证通过：
  - `pnpm vitest run src/plugin/vscode-extensions-inventory.test.ts tests/integration/plugin.test.ts tests/unit/plugin-tools.test.ts`
  - `bash -n src/plugin/scripts/vscode-extensions/refresh.sh src/plugin/scripts/vscode-extensions/show.sh`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`
  - `pnpm test`：21 个 test files，79 个 tests。
  - `pnpm exec tsx src/index.ts backup --dry-run` 显示 `vscode-extensions` 为 1 个清单文件。

### 结果

- `executeBackupPlan` 现在写入 `timestamp.in-progress`，成功后 rename 为正式快照，失败会清理临时目录。
- `pruneSnapshotsDetailed` 对旧快照删除失败不再抛出；footer 会显示 `prune failed N`，新快照仍算成功。
- Raycast 插件从整个 `~/Library/Application Support/com.raycast.macos` 收窄为：
  - `~/Library/Application Support/com.raycast.macos/extensions`
  - `~/Library/Preferences/com.raycast.macos.plist`
- 不再备份 Raycast 的 `index/`、sqlite WAL、PostHog、quotes 等高频变动缓存。
- 验证通过：
  - `pnpm vitest run src/engine/prune.test.ts src/engine/run-backup.test.ts tests/unit/backup-format.test.ts tests/integration/plugin.test.ts`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`
  - `pnpm test`：19 个 test files，70 个 tests。

## Raycast 扩展清单

### 假设

- Raycast 插件应备份偏好 plist 和扩展清单，不备份扩展运行缓存。
- 扩展清单写入 `~/.config/restore/inventory/raycast-extensions.json`。
- 不自动安装/恢复 Raycast 扩展。

### 计划

- [x] 记录计划。
- [x] 检查 Raycast 扩展元数据文件结构。
- [x] 新增 Raycast inventory 生成逻辑和 prepare hook。
- [x] 更新 Raycast 插件路径。
- [x] 补测试并运行验证。

### 结果

- Raycast 插件现在备份：
  - `~/.config/restore/inventory/raycast-extensions.json`
  - `~/Library/Preferences/com.raycast.macos.plist`
- 新增 `raycast-extensions` prepare hook：扫描 Raycast `extensions` 的直接子目录，写出扩展清单。
- 清单只记录扩展目录 ID、路径和顶层 `package.json` 元数据；不递归进入 `com.raycast.api.cache`。
- 不再备份整个 `~/Library/Application Support/com.raycast.macos/extensions` 目录。
- 验证通过：
  - `pnpm vitest run src/plugin/raycast-inventory.test.ts tests/integration/plugin.test.ts`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`
  - `pnpm test`：20 个 test files，73 个 tests。

## sync 进度面板

### 假设

- “慢”主要来自大量文件逐个 hardlink/copy，尤其是 `vscode-extensions`，不是 Raycast 当前 inventory。
- 最小可用体验是同步阶段按插件输出完成状态和 linked/copied 数量，最后输出总结果；不做复杂全屏 TUI。

### 计划

- [x] 记录计划。
- [ ] 检查当前 progress/backup 输出实现。
- [x] 为同步阶段增加插件级完成结果。
- [x] 补测试并运行验证。

### 结果

- 同步慢的主要原因是大量文件操作，尤其是 `vscode-extensions` 的 39874 个文件；每个文件都要 hardlink/copy 到 iCloud 目录。
- `executeBackupPlan` 现在返回 `pluginResults`，包含每个插件的 linked/copied 数量。
- 同步过程中每个插件完成后会在 TTY 输出：
  - `✓ <plugin> · <linked> linked · <copied> copied`
- backup 最后新增 `Synced plugins:` 面板，展示每个插件最终同步结果。
- 验证通过：
  - `pnpm vitest run src/engine/run-backup.test.ts tests/unit/backup-format.test.ts`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm build`
  - `pnpm test`：20 个 test files，74 个 tests。

## VS Code extensions 清单

### 假设

- `vscode-extensions` 应备份扩展 ID 清单，不备份整个 `~/.vscode/extensions` 目录。
- 插件名保持 `vscode-extensions`，让现有配置自动使用新行为。
- 清单写入 `~/.config/restore/inventory/vscode-extensions.txt`。
- 不自动安装扩展；恢复时用户可用清单配合 `code --install-extension`。

### 计划

- [x] 记录计划。
- [x] 新增 VS Code extensions 清单生成逻辑和 prepare hook。
- [x] 更新 `vscode-extensions` 插件定义和工具脚本。
- [x] 补测试并运行验证。

## TypeScript CLI SOP

### 假设

- 用户要创建可跨项目复用的 TypeScript CLI 开发 SOP，而不是修改当前项目源码。
- SOP 参考本项目实际技术栈：`commander`、`@clack/prompts`、`json5`、`zod`、`vitest`、`biome`、`pnpm`。
- 按 SOP manager 规则，用户级 SOP 写入 `~/.sops/typescript-cli.md`。

### 计划

- [x] 读取 SOP manager 规则。
- [x] 检查当前项目的 `package.json`、README、TypeScript/Biome 配置。
- [x] 创建 TypeScript CLI SOP。
- [x] 验证 SOP frontmatter 和内容可读。

### 结果

- 已创建用户级 SOP：`~/.sops/typescript-cli.md`。
- SOP 覆盖 TypeScript CLI 的命令契约、依赖选择、命令层边界、dry-run、测试、质量门禁和发布表面检查。
- 验证通过：用 Node 检查 frontmatter 包含 `name`、`description`、`version`、`owner`，并完整读取 SOP 内容。

## 个人 CLI 工具 wiki

### 假设

- wiki 放在当前项目的 `docs/cli-tools.md`，作为以后集中记录个人 CLI 工具的入口。
- 第一条只记录当前 `restore-cli`，不扩展成复杂目录或模板系统。
- Git 地址以当前仓库 remote 为准；npm 地址以已发布 npm 包为准。

### 计划

- [x] 检查当前仓库 Git remote、npm 包名和已暴露 CLI 命令。
- [x] 创建个人 CLI 工具 wiki。
- [x] 验证文档内容包含 Git 地址、npm 地址和基础功能。

### 结果

- 已创建 `docs/cli-tools.md`，作为个人 CLI 工具 wiki。
- 第一条记录为 `restore-cli`，包含 Git 地址、GitHub 地址、npm 地址、安装方式、基础命令、基础功能和备注。
- 验证通过：`rg` 检索到 Git 地址、npm 地址、当前发布版本和核心命令。

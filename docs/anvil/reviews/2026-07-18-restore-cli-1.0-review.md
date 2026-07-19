# 最终 MR 评审：`2026-07-18-restore-cli-1.0`

## 元数据

| 字段 | 值 |
|---|---|
| MR / Commit | T1 `87ef202`；T2 `c932b57`；T3 `f27abad`；T4 `8550bd2`；T5 `9245cf7`；T6 `7bca045`；T7 accepted working tree，task commit pending |
| Author | anvil-doer / anvil-lead |
| Review Date | 2026-07-18 |
| Review Writer | anvil-lead |
| Status | `APPROVED`（T1-T7 accepted write sets；完整 1.0 MR 仍 active） |

## 第一层：3 分钟读懂

### 1. Review 摘要

- **一句话结论**：T1-T7（仓库/保护、来源/备份、验证/保留/状态、staging/apply/rollback、legacy 迁移、新 Mac recovery plan/受控安装、持久调度/通知）均通过最终复核，当前无未解决 Critical / High / Medium finding。
- **为什么现在要改**：1.0 的备份、验证、恢复和调度都依赖同一个仓库身份、认证加密、锁和操作结果契约；基础错误会向所有后续任务扩散。
- **交付结果**：除 v1 repository/protection 与 declarative verified backup 外，新增 structural/content verify、healthy retention/status、authenticated staging/apply/rollback、strict legacy 0.1.x read/restore、copy-only migration，以及默认零安装的新 Mac recovery plan 与显式 allowlisted installer resume。
- **主要影响**：T1-T7 accepted write sets；root CLI/package 与 release hardening 仍由 T8-T9 完成。
- **Reviewer Action**：先看 T7 launchd lifecycle、one-shot backup boundary、local history/RPO/notification，再看 T6 installer lease 与 T4 Safety lifecycle；T1-T5 细节见各任务补充。

### 2. 背景与目标

#### Before / After

| 视角 | Before | After |
|---|---|---|
| 用户 / 调用方行为 | 仅有 0.1.x snapshot 目录，无可信 v1 repository 初始化 | 可显式初始化加密/明文仓库，身份或能力错误在业务写入前失败 |
| 系统内部行为 | 无共享认证写 handle、credential lifecycle 或跨进程安全锁 | descriptor-last durable publish、authenticated write handle、quarantine lock、bounded history |
| 评审 / 运维方式 | 缺少安全 failure vectors | 61 个 repository tests 覆盖篡改、竞态、symlink、凭据和中断边界 |

- **背景 / 问题**：confirmed MRD 的 FR-01、FR-02、FR-07 是所有恢复能力的 P0 前置。
- **本次目标**：建立最小、版本化、可验证且可安全失败的 repository/protection contracts。
- **非目标**：恢复点 capture、verify/retention、restore、migration、scheduler 和 root CLI wiring。
- **成功标准**：T1 plan success criteria、无 open Critical/High/Medium、focused/full tests、typecheck、build、Biome 全通过。

### 3. 技术方案与方案取舍

- **技术方案**：Node stdlib + macOS absolute native binaries；repository descriptor 绑定稳定目标身份；Keychain master key + 独立 recovery secret；内容使用带 AAD 的 AES-256-GCM；写操作先认证再 capability probe。
- **关键机制**：bounded no-follow/non-blocking I/O、文件及目录 fsync、descriptor-last publish、私有 WeakSet 写授权、整个 `locks/` parent 原子 quarantine、严格 operation result schema。
- **调用链 / 数据流**：

```text
init/open -> stable identity + layout validation -> credential authentication
          -> write capability probe -> authorized handle -> lock/mutation/result
```

| 方案 | 优点 | 代价 / 风险 | 选择结论 |
|---|---|---|---|
| stdlib + macOS native tools | 无新依赖，符合 Apple Silicon scope | Node 无 openat；需 dev/ino 重检 | 采用并 fail closed |
| 整个 locks parent quarantine | 阻断 clearer/acquirer ABA | cleanup 失败需保留 quarantine 诊断 | 采用 |
| 当前 wrapper rewrap | 不重写历史 blob | 已复制的旧 wrapper+secret 无法召回 | 采用并明确密码学边界 |

### 4. 修改边界与影响

#### Current Diff 范围

- **Base / Head**：`main@8eafc54` -> T1 working tree。
- **Changed Files**：`src/repository/**`、`src/protection/**`、`src/cli/repository.ts`、`tests/repository/**`；本 review/plan/MRD/research artifacts。
- **Touched Symbols**：`initializeRepository`、`openRepository`、`preflightTarget`、`acquireRepositoryLock`、credential lifecycle、content protectors、operation result/history。
- **Affected Modules**：repository、protection；后续 T2-T9 consumer contracts。
- **Loaded Standards**：AGENTS.md、Anvil req/plan/code/review/compound、TypeScript CLI SOP、Biome/project conventions。
- **Requirements / Plan**：confirmed MRD FR-01/02/07；active plan T1。

| 边界 | 范围 | 变化 / 影响 | 证据 |
|---|---|---|---|
| Changed | T1 ownership | 新增安全 repository/protection foundation | 27 owned source/test files |
| Direct impact | 后续写操作 | 必须通过 authenticated write handle + repository lock | `authorization.ts`, `lock.ts` |
| Indirect impact | T2-T9 | 共享 identity/protector/result contracts | active plan DAG |
| Not changed | legacy engine/root CLI/package | 不改变当前 0.1.x 命令行为 | ownership audit |

### 5. Reviewer 导航 / 热点

| 优先级 | 文件 / Symbol / 链路 | 为什么要看 | 建议验证方式 |
|---|---|---|---|
| P0 | `repository.ts` open write | 必须 auth-before-write | wrong/missing credential mtime test |
| P0 | `lock.ts` clear paths | ABA/remote/orphan lock 风险 | concurrent clearer + successor tests |
| P0 | `target.ts` stable identity | 防止掉盘后写入替代目标 | replacement-before-probe tests |
| P1 | `credentials.ts` rotation/revoke | commit 与 cleanup 不能含糊 | injected release/fsync tests |
| P1 | `operations.ts` | 防伪 success、secret、fan-out、pending residue | schema/safe history tests |

- **建议阅读顺序**：types/layout -> target/repository -> protection -> lock -> credentials -> operations -> tests。
- **最可能出错的假设**：rename durability、mount source privacy、clearer/acquirer interleaving、cleanup masking committed state。
- **需要领域 Reviewer 确认的事项**：无；当前 scoped reviewer 已 APPROVED。

## 第二层：技术评审正文

### 6. 需求—实现—验证映射

| Requirement / Success Criterion | Implementation | Current Diff Evidence | Verification | 状态 / 缺口 |
|---|---|---|---|---|
| FR-01 repository identity/capability | descriptor + stable volume/share ID + preflight | `src/repository/target.ts`, `repository.ts` | replacement/missing/space/read-only tests | verified |
| FR-02 authenticated encryption | GCM + AAD + Keychain + recovery wrap | `src/protection/**` | wrong key/tamper/substitution tests | verified |
| FR-02 no secret argv/log/JSON | stdin-only absolute Keychain; strict result strings | `keychain.ts`, `operations.ts` | secret surface tests | verified |
| FR-02 export/rotation/revoke | persisted readback, durable rewrap, explicit outcomes | `credentials.ts`, CLI exporter | corrupt/no-op/fsync/release tests | verified |
| FR-07 cross-process exclusion | mkdir acquire + locks-parent quarantine | `lock.ts` | live/stale/orphan/remote/concurrent tests | verified |
| T1 bounded safe I/O/results | no-follow/non-blocking bounded reads; strict schema | `io.ts`, `operations.ts` | FIFO/symlink/oversize/fan-out/pending tests | verified |

### 7. 风险、兼容性、发布、回滚与观测

| 主题 | 结论 | 触发信号 / 影响 | 处置与证据 |
|---|---|---|---|
| 技术 / 产品风险 | 当前无 open P0/P1 finding | identity/auth/lock failure | stable categorized errors + tests |
| 向后 / 向前兼容性 | 新 v1 writer 尚未 root-wired；legacy reader 留给 T5 | unsupported descriptor | explicit format error |
| 数据 / 配置 / 协议兼容性 | descriptor format=1；stable ID required | replacement/reconnect | tests + exact mount policy |
| 发布策略 | T1 task commit only，不 publish npm | downstream not complete | plan remains active |
| 回滚策略 | revert T1 commit；当前 CLI 未注册新命令 | build/regression | task-level commit boundary |
| 观测 / 告警 | stable error category/code；bounded operation JSON | cleanup/durability warning | lifecycle result fields |

- **回滚步骤**：revert T1 task commit；不删除用户 repository 或 recovery credential。
- **回滚后数据 / 状态处理**：新格式尚未对现有 root CLI 暴露，无自动数据迁移。
- **发布后确认窗口与负责人**：T8/T9 integration/release drill；anvil-lead。

### 8. Current Diff Findings 与完整闭环

| ID | Severity | 原始问题摘要 | Current Diff Evidence | 状态 | 轮次 | Contributors |
|---|---|---|---|---|---|---|
| F1 | Critical | stale clear ABA / orphan lock | `lock.ts` parent quarantine | fixed | R1 | reviewer/doer |
| F2 | Critical | symlink parent 把 recovery secret 写入仓库 | canonical exporter + no-follow | fixed | R1 | reviewer/doer |
| F3 | High | encrypted write 未认证先 probe | auth-before-write + WeakSet | fixed | R1 | reviewer/doer |
| F4 | High | recovery artifact 未实际读回且 publish 不 durable | fsync/readback/descriptor-last | fixed | R1 | reviewer/doer |
| F5 | High | false success / recovery secret 可进入 JSON | strict runtime schema | fixed | R1 | reviewer/doer |
| F6 | High | 缺 rotation/revoke；cleanup 可掩盖 committed outcome | explicit lifecycle outcomes | fixed | R1-R3 | reviewer/doer |
| F7 | Medium | runtime identity 不持久 | VolumeUUID / hashed remote endpoint | fixed | R2 | reviewer/doer |
| F8 | Medium | history symlink/fan-out/unbounded read | bounded sequential safe I/O | fixed | R1-R2 | reviewer/doer |
| F9 | Medium | 不可证明的 remote valid lock 无确认通路 | exact owner+ID confirmed clear | fixed | R2 | reviewer/doer |
| F10 | High | hash credential-bearing mount source 形成离线 verifier | strip userinfo before hash | fixed | R3 | reviewer/doer |
| F11 | Medium | crash `.pending` 永久毒化 history | bounded ignore + auth cleanup | fixed | R3 | reviewer/doer |
| F12 | Medium | committed + directory sync failed 分支无测试 | injected real commit/failure seam | fixed | R3 | reviewer/doer |

#### Findings 闭环

- **触发条件与后果**：竞态、路径别名、错误凭据、掉电/中断、篡改 repository、凭据轮换和远端锁均曾产生错误成功、secret exposure、并发写或不可恢复风险。
- **根因**：最初实现把 lexical path/rename/lstat/cleanup success 当作更强保证，并遗漏 confirmed MRD 的 credential lifecycle。
- **修复方案**：认证门禁、stable identity、bounded safe I/O、directory fsync、whole-parent quarantine、严格结果 schema、显式 commit/cleanup outcome。
- **为何充分**：每个 finding 均有 current-diff regression；独立 reviewer 三次复核，最终无 open Critical/High/Medium。
- **验证证据**：61/61 focused、145/145 full、typecheck/build/Biome；focused adversarial probes。
- **状态 / 轮次 / Contributors**：全部 fixed；anvil-doer 实现，anvil-reviewer 独立复核，anvil-lead 裁决。

#### 修复轮次与复核

| 轮次 | Finding IDs | 修复摘要 | Current Diff 复核 | 验证 | ReviewerContribution |
|---|---|---|---|---|---|
| R1 | F1-F8 | quarantine、canonical export、auth handle、durable I/O、strict schema、lifecycle | 发现 F6-F8 残余 | 49 tests | BLOCKED |
| R2 | F6-F9 | explicit lifecycle outcomes、stable ID、history cap、confirmed remote clear | 发现 mount-source verifier 与 pending residue | 58 tests | BLOCKED |
| R3 | F10-F12 | strip userinfo、pending convergence、unsynced commit test | final scoped re-review | 61 tests | APPROVED |

### 9. Knowledge Used

| Knowledge Page / Conclusion | 如何影响设计或评审 | Current Evidence | 一致性 / 冲突 |
|---|---|---|---|
| 无 matching knowledge page | current MRD/plan/code/tests 优先 | `docs/anvil/knowledge/` 不存在 | unrelated |

- **Draft clues**：0。
- **Relevant conflicts**：0。
- **Unrelated conflicts**：0。

### 10. Knowledge Impact

| Knowledge Page / Scope | Changed File / Symbol / Module | Impact | Current Evidence | Required Action | Synchronization / Conflict Decision |
|---|---|---|---|---|---|
| T1 repository/protection | T1 owned modules | `none` | implementation-specific verified foundation | none | no reusable lesson |

- **Compound / Review-Auto 审计证据引用**：见第 15 节。

### 11. 已知限制与后续事项

| Item | 类型 | 影响 / 原因 | Owner | 时机 / 跟踪位置 |
|---|---|---|---|---|
| 旧 wrapper + 旧 recovery secret 的已复制组合不可召回 | known limitation | 密码学边界；当前 wrapper rotation 不能删除攻击者副本 | product/docs | T8 docs |
| Node stdlib 无 openat/renameat | accepted debt | 通过 no-symlink dev/ino 重检 fail closed | engineering | T9 fault tests |
| root CLI 尚未注册 repository commands | follow-up | serial plan 明确由 T8 统一 wiring | T8 | active plan |

## 第三层：审计附录

### 12. Contributors

| Reviewer | Role | Scope | Files / Dimensions | Findings | Verification | Knowledge Impact |
|---|---|---|---|---|---|---|
| anvil-reviewer-t1 | adversarial reviewer | T1 | crypto, paths, locks, lifecycle, identity, I/O | F1-F12 fixed | probes + 61 focused | none |
| anvil-lead | final arbiter | T1 + workflow artifacts | spec trace, ownership, full integration | approved | 145 full + build + Biome | none |

### 13. 自动化预检与安全

| 检查项 | 命令 / 范围 | 结果 | 证据 / 备注 |
|---|---|---|---|
| Lint | direct Biome `src tests` | PASS | 86 files；pnpm wrapper abnormal 但 direct binary clean |
| 类型检查 | `pnpm typecheck` | PASS | `tsc --noEmit` |
| 单元测试 | `pnpm test tests/repository` | PASS | 7 files / 61 tests |
| 其他验证 | `pnpm test`; `pnpm build` | PASS | 28 files / 145 tests；production build |
| 硬编码密钥 / 敏感日志 | current diff | CLEAN | absolute `/usr/bin/security`; secret stdin only |
| 注入 / XSS | CLI/native argv | CLEAN | no shell; absolute binaries; validated args |
| 依赖 CVE | changed dependencies | N/A | no dependency changes |

### 14. Karpathy 原则与适用维度

| 原则 | 结论 | Current diff 证据 |
|---|---|---|
| Think Before Coding | PASS | confirmed MRD + active plan + red regressions |
| Simplicity First | PASS | stdlib/native only；无通用 VFS/provider layer |
| Surgical Changes | PASS | T1 ownership audit clean |
| Goal-Driven Execution | PASS | findings 均映射 P0 criteria |

| 评审维度 | 结论 | 范围 / 备注 |
|---|---|---|
| Design | PASS | repository/protection contracts |
| Functionality | PASS | init/open/lock/lifecycle/results |
| Complexity | PASS | security-driven complexity only |
| Naming | PASS | stable categorized contracts |
| Comments | PASS | only non-obvious crypto/openat boundary |
| Style & Consistency | PASS | Biome/typecheck |
| Context | PASS | MRD/plan/research trace |
| Tests | PASS | fault/adversarial + full regression |

### 15. Compound / Review-Auto 审计

- **Review-Auto Applicability / Rationale**：same-open full-flow review 的 non-knowledge gates 已 provisional PASS。
- **Compound Authorization**：`review-auto`
- **Compound Status**：`active`
- **Compound Mode**：`apply`
- **Fresh Ephemeral OperationPlan**：`plan_version: compound/v2`; scope T1 repository/protection；0 candidates/operations。
- **Operations**：0。
- **Independent Preflight**：knowledge root missing；candidate/schema/link/conflict/sensitive/`plan_drift` 均无 target，pass/not-applicable；current code/tests inspected。
- **Exact Knowledge Writes**：0。
- **Exact Knowledge Deletes**：0。
- **Independent Postflight**：skip；zero-write no-op。
- **CompoundResultV2**：

```text
Action: submit
Mode: apply
Scope: T1 repository/protection verified foundation
Candidates: 0
Active: 0
Draft: 0
Conflicts: 0
Operations: 0
Writes: 0
Deletes: 0
Validation: Collect pass; Select no candidates; Rank skip; Inspect Evidence pass for current code/tests; Decide no reusable candidate; Validate pass/not-applicable including plan_drift; Apply skipped; Revalidate skipped because zero-write
Decision: no-reusable-lesson
```

### 24. T7 持久调度、历史、degraded 与通知评审补充

#### T7 摘要、边界与结果

- **一句话结论**：T7 将不持久 detached interval worker 替换为用户级 one-shot LaunchAgent；最终 scoped review 无未解决 Critical / High / Medium finding。
- **Before / After**：从 PID 文件、进程内 interval、legacy backup engine，升级为登录后持续注册的 `launchd` StartInterval job、严格 v1 backup、repository lock、私有有限 history、24h RPO degraded 和本地通知。
- **Accepted Write Set**：`src/daemon/**`、`src/scheduler/**`、`src/cli/daemon.ts`、`tests/scheduler/**`、daemon integration tests，以及 parent-owned plan/review 状态。
- **非目标**：scheduler 不执行 retention/destructive maintenance、migration、apply、rollback、recovery installer 或任意 shell；root CLI 统一平台门禁和 release package 由 T8 完成。

#### T7 需求—实现—验证映射

| Requirement / Success Criterion | Implementation | Verification | 状态 |
|---|---|---|---|
| FR-16 默认 12h / `0` disabled | config interval 转确定性 `StartInterval`；`0` start 主动 bootout/remove；stale worker 再次检查 disabled | plist、CLI disabled/idempotency tests | verified |
| 登录/重启后持续 | `~/Library/LaunchAgents/com.ssbun.restore-cli.scheduler.plist`；`RunAtLoad` + `StartInterval`；worker 每次单次运行后退出 | deterministic plist + `plutil -lint` + injected bootstrap/bootout/print tests | verified |
| 同仓库不重叠 | one-shot worker 仅调用 `createV1RecoveryPoint`，由现有 repository backup lease 仲裁；launchd 同 label 不并发启动 | dependency boundary、lock-result preservation/notification tests | verified |
| 目标缺失不建替代路径 | 对 exact repository path 只做 `lstat`；失败在 plugin prepare / backup service 前返回 | missing-target test 断言 prepare/create 均零调用 | verified |
| 24h degraded | 实际 authenticated repository status 优先；bounded history fallback；严格 `> 24h` 边界 | exact boundary、stale/no healthy、status failure tests | verified |
| 有限本地 history | 0700 state/history、0600 final records、strict schema、64KiB/file、100 final records、atomic pending→final、目录 fsync | rotation、mode、malformed/symlink/unknown-key tests | verified |
| 无人值守通知 | fixed `/usr/bin/osascript` JXA，无 shell；generic bounded message；failure/degraded/target-change/content-verify/notification failure 可见 | command allowlist/control-byte、classified failure tests | verified |
| 禁止自动高风险动作 | scheduler dependency surface 只有 config、target read、v1 backup、read-only status、local history、notification | source audit 无 migration/apply/install/retention/shell | verified |

#### T7 Findings 闭环与复核结果

| Finding / 风险 | Severity | 修复 / 证据 | 最终状态 |
|---|---|---|---|
| detached child 在 CLI 退出/登录重启后不可靠 | High | 持久 LaunchAgent + deterministic plist + one-shot worker | fixed |
| launchctl 无法执行时可能误报 stopped | High | command result 区分 service nonzero 与 execution error；stop/status fail closed | fixed |
| 缺盘时可能创建本地同名 repository | High | exact no-follow `lstat` gate；无 mkdir/prepare/write | fixed |
| history/plist symlink 与发布竞态 | High / Medium | `O_NOFOLLOW`、held directory/file identity、exclusive pending、atomic rename、fsync、strict bounded parse | fixed |
| auth/target failure 丢失上次 healthy 时间并立即误判 | Medium | authenticated status 非空才替换；local latest-healthy fallback；当前 verified point fallback | fixed |
| 已发布 healthy point 因 lock release degraded 被漏记 | Medium | status-confirmed latest healthy ID 可独立于 operation state 标记 publication | fixed |
| osascript 通知命令不具 Standard Additions | Medium | fixed JXA 启用 `includeStandardAdditions`；title/body bounded/control sanitized | fixed |
| 全量高并发慢测触发现有硬编码 timeout | Low / test harness | 两项均 isolated pass；最终 3-worker / 60s global clean 421/421，migration 自身 15s gate 未放宽 | verified non-regression |

#### T7 自动化、风险与 ReviewerContribution

| 检查项 | 结果 | 证据 |
|---|---|---|
| Focused | PASS | scheduler/daemon/status 11 files / 41 tests |
| Full regression | PASS | 52 files / 421 tests；3 workers，global 60s；existing migration explicit 15s gate preserved |
| Type / Build | PASS | `pnpm typecheck`；`pnpm build`；built worker/scheduler artifacts present |
| Lint / Diff | PASS | direct Biome 20 affected + 156 whole-repo files；`git diff --check` |
| Native contract | PASS | local `launchctl help` signatures；generated plist `plutil -lint` OK；tests inject launchctl and never touch real LaunchAgents |
| Security / Scope | PASS | fixed executables、no shell、generic notifications、bounded no-follow local state、target zero-write preflight、backup-only dependency surface |

- **回滚**：bootout/remove LaunchAgent 后 revert T7 task commit；保留 bounded scheduler history 供诊断，不删除 repository recovery points。
- **观测**：每个 scheduled run 输出/记录 start/end/duration/state/category/point/healthy/RPO/issue/notification；`daemon status` 显示 installed/loaded/next/RPO/history。
- **Known limitation**：next schedule 是基于 LaunchAgent interval 和最近 start 的确定性估算；macOS 最终触发时间仍由 launchd 的 sleep/wake coalescing 决定。Node stdlib 无 `openat`，因此本地 state/plist 采用 no-follow descriptor 与 dev/ino 重检并 fail closed。
- **Knowledge Impact**：none；当前结论为本项目 scheduler contract 的实现特定 hardening，zero-write compound。

| Reviewer | Role | Scope | Findings | Verification | Knowledge Impact |
|---|---|---|---|---|---|
| implementation | T7 code/test implementation | launchd/history/run/status/notification/daemon CLI | 关闭全部 scoped findings | 41 focused / 421 full | none |
| anvil-lead | scoped final arbiter | MRD/plan trace、security boundary、fault evidence、task ownership | APPROVED；0 open C/H/M | type/build/Biome/diff/plutil/full | none |

#### T7 CompoundResultV2

```text
Action: submit
Mode: apply
Scope: T7 persistent launchd scheduling, bounded local history, degraded state and notification
Candidates: 0
Active: 0
Draft: 0
Conflicts: 0
Operations: 0
Writes: 0
Deletes: 0
Validation: Collect pass; Select no candidates because no knowledge root exists; Rank skip; Inspect Evidence pass for current MRD/plan/code/tests/review; Decide no reusable candidate; Validate pass/not-applicable including conflicts, sensitive data, links, schema and plan_drift; Apply skipped because zero operations; Revalidate skipped because zero-write
Decision: no-reusable-lesson
```

### 23. T6 新 Mac recovery plan 与受控安装评审补充

#### T6 摘要、边界与结果

- **一句话结论**：T6 经三轮独立对抗复核和 lease/scanner 最终窄修复后通过，最终无 Critical / High / Medium / Low finding。
- **Before / After**：从无新 Mac 恢复编排，升级为认证 recovery point → isolated staging → 当前/期望 inventory diff → 默认 missing-app/manual report；只有显式审批、显式阶段确认和交互调用才可执行 Homebrew/VS Code allowlist。
- **Accepted Write Set**：`src/recovery-plan/**`、`src/cli/recover.ts`、`tests/recovery-plan/**`；以及 original-path overlap、apply fidelity consent、byte-oriented recovery credential 所需的最小共享 recovery/protection/repository/CLI 文件与测试（以计划 T6 Ownership 为准）。
- **非目标**：不 root-wire 命令（T8）；不自动安装 App Store、DMG、Raycast、未知应用；不自动 apply 配置；不创建通用 installer framework。

#### T6 需求—实现—验证映射

| Requirement / Success Criterion | Implementation | Verification | 状态 |
|---|---|---|---|
| 默认只恢复配置、应用仅报告 | 全量认证 staging；`software`/manual diff；默认 dry-run，零 installer、零原路径 apply | CLI default/no-process、missing/manual inventory tests | verified |
| Apple Silicon only | platform/architecture gate 在 repository/inventory I/O 前执行 | non-arm64 pre-I/O test | verified |
| 受控 allowlisted installer | strict Brewfile/VS Code grammar；重新合成单项 Brewfile；固定绝对 executable；`shell:false` | traversal/directive tests、exact argv/phase tests | verified |
| 显式审批、dry-run、恢复执行 | exact plan fingerprint、phase confirmation、private bounded journal、pending/failed resume | fingerprint/journal tamper/limit/resume tests | verified |
| 跨进程唯一执行 | plan-wide authoritative lease；完整 pending dir 原子发布；unique Brewfile | phase/state-dir concurrency、publication race tests | verified |
| child 生命周期安全 | `idle | launch-pending | running`；spawn 前 durable sentinel；unknown-child wedge 永不 auto-quarantine；running 仅 dead PID + expired 才清 | PID publication failure、unreaped child、expired launch-pending tests | verified |
| current inventory bounded/no-follow | cwd-bound worker 先验证 dev/ino；nested directory rebinding；parent post-check；plist final held/named identity check | root/nested symlink swap、limit、plist conversion drift tests | verified |
| partial staging 不伪装成功 | staging issues 进入 plan/apply fingerprint；execute apply 需 exact fidelity consent；post-lock re-auth | partial plan、wrong/missing consent、issue-set drift tests | verified |
| 独立 recovery credential | byte-oriented import；single-owned bounded buffer；所有可控 secret buffer dispose/wipe | missing/malformed/round-trip/wipe tests | verified |
| 稳定自动化错误 | 完整 failure schema；malformed/oversized journal → integrity / `INSTALL_JOURNAL_INVALID` | real CLI boundary tests | verified |

#### T6 Findings 闭环与修复结果

| 问题簇 | Severity | 修复证据 | 最终状态 |
|---|---|---|---|
| partial staging success laundering / apply bypass | Medium | truthful partial fields、approval fingerprint、exact apply fidelity consent、post-lock issue-set recheck | fixed |
| staging 与原配置路径重叠 | Medium | requested/canonical 双向 overlap preflight，在任何 staging child 前拒绝 | fixed |
| manual work/journal bounds/unknown inventory 丢失 | Medium | deterministic manual journal rows/counts；统一 4 MiB/10k limit；bounded unknown manual output | fixed |
| phase/state-dir lock 绕过、Brewfile race | Medium | repository/point/plan-wide authoritative lease；逐 action exclusive unique Brewfile | fixed |
| unbounded/竞态 current scans | Medium | bounded cwd-bound no-follow workers；incomplete → unknown；plist conversion 后 full identity recheck | fixed |
| stale lease 忽略 child、spawn publish gap | High | complete-dir atomic publish；launch-pending 永不自动清；running child PID/expiry 双门禁；active lease 禁止 release | fixed |
| credential 副本/不可擦除字符串 | Medium | CLI byte import；single-owned read buffer；decoded/recovery payload dispose/wipe | fixed |
| journal/CLI 分类不稳定 | Medium / Low | sanitized complete schemas；read/parse/phase/oversize failures统一 integrity | fixed |
| Brew identifier path semantics | Medium | tap/package directive-specific segment grammar；拒绝 `.`, `..`, 重复/首尾 slash、反斜杠 | fixed |

#### T6 自动化、风险与 ReviewerContribution

| 检查项 | 结果 | 证据 |
|---|---|---|
| Focused | PASS | final recovery-plan 68/68；execute/current 31/31 |
| Affected regression | PASS | recovery/CLI/protection/safe-read 69/69 |
| Full regression | PASS | 47 files / 399 tests |
| Type / Build | PASS | `tsc --noEmit`；`pnpm build` |
| Lint / Diff | PASS | direct Biome 26 accepted files；`git diff --check` |
| Independent review | APPROVED | final 0 open Critical / High / Medium / Low |

- **回滚**：revert T6 task commit；保留已生成的 staging、journal 与 manual report 供诊断，不自动删除用户数据。
- **观测**：稳定 plan/install result 输出 state/category、point/fingerprint、manual/action counts、issues 与 nextAction。
- **Known limitation**：dead-parent `launch-pending` 无法证明 child 是否启动，因此安全地保持人工 wedge；Mac App Store、DMG、Raycast 与未知应用始终 manual。
- **Knowledge Impact**：none；结论属于本 recovery-plan/lease contract 的实现特定 hardening，zero-write compound。

| Reviewer | Role | Scope | Findings | Verification | Knowledge Impact |
|---|---|---|---|---|---|
| anvil-doer-t6 | implementation | T6 accepted write set | 关闭全部 findings | 68 focused / 399 full | none |
| anvil-reviewer-t6 | independent adversarial review | plan/inventory/install lease/apply consent/credential/CLI | final APPROVED；0 open C/H/M/L | static final + focused evidence | none |
| anvil-lead | final arbiter | plan trace、ownership、full regression、compound、task boundary | accepted | full/type/build/Biome/diff | none |

#### T6 CompoundResultV2

```text
Action: submit
Mode: apply
Scope: T6 authenticated new-Mac recovery plan and controlled installers
Candidates: 0
Active: 0
Draft: 0
Conflicts: 0
Operations: 0
Writes: 0
Deletes: 0
Validation: Collect pass (review-auto); Select no candidates because no knowledge root exists; Rank skip; Inspect Evidence pass for current MRD/plan/code/tests/review; Decide no reusable candidate; Validate pass/not-applicable including conflicts, sensitive data, links, schema and plan_drift; Apply skipped because zero operations; Revalidate skipped because zero-write
Decision: no-reusable-lesson
```

- **Unrelated Conflicts Reported**：0。
- **Relevant Conflict Resolution**：N/A。

#### T2 CompoundResultV2

```text
Action: submit
Mode: apply
Scope: T2 source contract and verified v1 backup
Candidates: 0
Active: 0
Draft: 0
Conflicts: 0
Operations: 0
Writes: 0
Deletes: 0
Validation: Collect pass (review-auto); Select no candidates because docs/anvil/knowledge is absent; Rank skip; Inspect Evidence pass for current MRD/plan/code/tests/review; Decide no reusable candidate; Validate pass/not-applicable including conflicts, sensitive data, links, schema and plan_drift; Apply skipped because zero operations; Revalidate skipped because zero-write
Decision: no-reusable-lesson
```

### 16. MigrationDisposition

N/A（非迁移 task）。

### 17. 门禁

| 门禁项 | 状态 | 证据 / 阻塞项 |
|---|---|---|
| 3 分钟摘要可独立解释背景、Before/After、技术方案、边界、影响与 Reviewer 热点 | PASS | sections 1-5 |
| 需求—实现—验证映射完整，未验证项显式 | PASS | section 6 |
| 风险、兼容性、发布、回滚、观测、已知限制与后续事项完整 | PASS | sections 7/11 |
| 自动化检查满足风险要求 | PASS | section 13 |
| 安全扫描干净 | PASS | no secret/path/native injection findings |
| Karpathy 4/4 | PASS | section 14 |
| 无未解决 Critical / High finding | PASS | final reviewer APPROVED |
| Findings 均有 current diff 证据且闭环完整 | PASS | section 8 |
| Knowledge Used 与 Knowledge Impact 已分离记录 | PASS | sections 9/10 |
| Knowledge Impact 已同步或无需写入 | PASS | no-reusable-lesson |
| Compound / Review-Auto 审计完整 | PASS | section 15 |
| 无未裁决相关知识冲突 | PASS | 0 conflicts |
| Source of truth、验证证据、恢复点完整 | PASS | MRD/plan/tests/task commit boundary |
| 本 MR 只有一个 human-facing review 文档 | PASS | this file |

### 18. T2 来源契约与可验证备份评审补充

#### T2 摘要、边界与结果

- **一句话结论**：T2 在四轮阻塞修复后通过最终独立复核，当前无未解决 Critical / High / Medium finding。
- **Before / After**：从内置 `paths` + legacy snapshot 写入，升级为统一 declarative source contract、严格用户 JSON plugin、稳定 no-follow capture、受保护 `.pending` recovery point、内容读回验证和目录绑定原子 publish。
- **Accepted Write Set**：`src/catalog/**`、`src/plugin/**`、`src/config/**`、`src/engine/v1-backup.ts`、`src/cli/backup.ts`、`tests/backup/**`、`tests/integration/plugin.test.ts`；共 23 个 owned source/test files。
- **非目标**：恢复点 health/retention/list 由 T3；staging/apply/rollback 由 T4；legacy migration 由 T5；root CLI/package wiring 由 T8。
- **兼容性**：旧 plugin `paths` 自动映射为 `optional/private`；legacy backup reader/engine 保留；新写入仅使用 v1 verified point。

#### T2 需求—实现—验证映射

| Requirement / Success Criterion | Implementation | Verification | 状态 |
|---|---|---|---|
| FR-03 声明式来源、严格 JSON、危险范围门禁 | `plugin/schema.ts`、stable loader、canonical/forbidden capture scope、source contract fingerprint | plugin/config/scope tests | verified |
| FR-04 hidden/no-follow/stable capture | held directory identities、bounded retry、incremental memory budget、group double-capture | restored parent/final ABA、mutation、size limit tests | verified |
| FR-05 metadata fidelity | file/dir/symlink/hardlink、mode/time/xattr/flags；fidelity loss => partial | native worker、malformed/permission/symlink tests | verified |
| FR-02 plaintext secret confirmation | repository + source + exact contract fingerprint；stale/orphan rejection；wizard prune | disable/re-enable + stale contract tests | verified |
| T2 verified publication | auth+lock before prepare；cwd-bound raw-stdin writer；protected blobs/manifest readback；inode-reconciled publish | interruption/tamper/ABA/lost-ack/lock-release tests | verified |
| FR-06 dry-run safety | frozen plan、structural verification scope、no prepare、read-only repository open、zero tree mutation | dry-run digest + CLI result tests | verified |
| 严格 machine result | all CLI paths emit one JSON result；stable category/exit；post-commit faults degraded | CLI/writer operation-result tests | verified |

#### T2 Findings 闭环

| ID 范围 | Severity | 问题簇 | 修复证据 | 最终状态 |
|---|---|---|---|---|
| T2-F1-F4 | High | source parent ABA、内存上限滞后、silent metadata loss、optional partial 被标 healthy | held path identity、pre-allocation budget、fidelity issues、health/result derivation | fixed |
| T2-F5-F8 | High | consistency group torn view、rename 后失败可见、stale plaintext consent、repository parent ABA | identity-rich double pass、commit/degraded semantics、contract fingerprint + prune、directory-bound repository I/O | fixed |
| T2-F9-F17 | Medium | canonical/repository overlap、plugin mutation、错误分类、cross-source hardlink、verification/end time、CLI exception、manifest reload、prepare 时序、lock release | canonical identity、stable plugin fd、source-local links、frozen plan、strict result、auth/lock-before-prepare | fixed |
| T2-R2-1-R2-5 | High/Medium | string-path repository/metadata ABA、disable/re-enable、group identity 缺失、degraded lock issue 丢失 | cwd-bound native workers、orphan rejection、dev/ino/ctime/nlink/topology、issue preservation | fixed |
| T2-R3-1-R3-2 | High | verified fd 仍可 restored-ABA 写出、rename worker 丢 ack 后 failure-visible | cwd-bound raw-stdin writer；final/pending held-inode reconciliation | fixed |

#### T2 修复轮次与 ReviewerContribution

| 轮次 | 结论 | 关键结果 | 验证 |
|---|---|---|---|
| R1 | BLOCKED | 8 High + 9 Medium；发现路径竞态、health、consistency、fidelity、consent、publication/result 缺口 | 172 tests baseline |
| R2 | BLOCKED | 大部分 finding 关闭；残留 repository/metadata ABA、consent lifecycle、group identity、lock release | 200 tests |
| R3 | BLOCKED | metadata/consent/group/lock 关闭；残留 sensitive write restored ABA 与 lost rename ack | 208 tests |
| R4 | APPROVED | cwd-bound writer + held-inode commit reconciliation 关闭最后两项；无 open Critical/High/Medium | 34 writer；211 full |

#### T2 自动化、风险与限制

| 检查项 | 结果 | 证据 |
|---|---|---|
| Focused | PASS | 53/53 T2 focused；final writer 34/34 |
| Full regression | PASS | 32 files / 211 tests |
| Type / Build | PASS | `pnpm typecheck`；`pnpm build` |
| Lint | PASS | direct Biome 99 files；`pnpm exec biome` wrapper 在本环境 exit 254，无 code diagnostic |
| Diff / Ownership | PASS | `git diff --check`；仅 T2 owned code/tests + parent-owned plan/review |
| Secret / injection | PASS | no shell；raw stdin；strict relative names；bounded stdout/stderr/timeouts；capture-only identity 从 manifest 删除 |

- **主要风险处理**：Apple Silicon/macOS 的 Node stdlib 没有 `openat/renameat`，因此生产 native metadata、敏感文件写入与 commit rename 使用无 shell、cwd kernel-binding、dev/ino 验证的窄 worker；任何未知/歧义 publication state fail closed 或返回 committed degraded。
- **回滚**：revert T2 task commit；不得删除已经存在的 v1 repository 或可见 recovery point。T2 尚未 root-wired，不触发自动 migration。
- **观测**：`OperationResult` 区分 configuration/auth/lock/source/destination/integrity；post-commit durability 与 lock-release 失败不伪装 success。
- **Known limitation**：明文仓库仍是显式危险模式；用户必须为每个 exact secret source contract 单独确认。完整 point list/health/retention 在 T3 实现。
- **Knowledge Impact**：none；没有可独立于当前 MRD/plan/code 的 reusable lesson，进入 zero-write compound gate。

#### T2 Contributors

| Reviewer | Role | Scope | Findings | Verification | Knowledge Impact |
|---|---|---|---|---|---|
| anvil-doer-t2 | implementation | T2 accepted write set | 关闭全部 finding | 53 focused / 211 full | none |
| anvil-reviewer-t2 | independent adversarial review | source/repository ABA、fidelity、consistency、publication、results | R1-R3 BLOCKED；R4 APPROVED | final writer 34/34 | none |
| anvil-lead | final arbiter | spec trace、ownership、full integration | accepted | independent full/type/build/Biome | none |

### 19. Current Final Decision

- **Decision**：`APPROVED`
- **Rationale**：T1-T5 accepted write sets 满足 confirmed MRD/plan；全部对抗 finding 闭环，326 tests、typecheck、build、Biome 全绿，无 knowledge conflict。
- **Unresolved Items**：无 T1-T5 blocker；T6-T9 仍按 active plan 执行。
- **Knowledge Synchronization**：T1-T5 均 zero-write；`Decision: no-reusable-lesson`。
- **Resume / Next Action**：提交精确 T5 write set，然后自动开始 T6。

### 20. T3 验证、健康、保留与状态评审补充

#### T3 摘要、边界与结果

- **一句话结论**：T3 经两轮阻塞修复和最终窄复核后通过独立评审，当前无未解决 Critical / High / Medium finding。
- **Before / After**：从仅有 legacy stat/prune，升级为严格 v1 structural/content verify、healthy/latest-healthy、确定性 14 healthy retention、Safety Point 保护钩子、单一认证快照 status 与稳定 CLI JSON/exit contract。
- **Accepted Write Set**：`src/verify/**`、`src/engine/v1-retention.ts`、`src/engine/v1-stat.ts`、`src/cli/verify.ts`、`src/cli/status.ts`、`tests/verify/**`、`tests/retention/**`、`tests/status/**`、`tests/integration/status-command.test.ts`。
- **非目标**：root CLI 统一注册由 T8；repair/salvage 不进入 1.0；staging/apply/rollback 由 T4；retention 不把 structural scope 冒充 content verify。

#### T3 需求—实现—验证映射

| Requirement / Success Criterion | Implementation | Verification | 状态 |
|---|---|---|---|
| FR-09 structural/content scopes 与 coverage | bounded discovery、strict manifest graph、auth/hash/length content read、non-vacuous coverage | corruption/missing/symlink/FIFO/auth/tamper tests | verified |
| healthy/latest healthy | required/commit/structural/unlock contract；partial/failed 排除；creation-time content-readback evidence | latest/partial/mixed repository tests | verified |
| FR-17 14 healthy retention | pure deterministic plan、last-healthy guard、Safety Point extra retention、dry-run parity、exclusive lock/drift fingerprint | 15-point、last healthy、Safety Point、drift、dry-run tests | verified |
| 安全删除 | cwd-bound quarantine、macOS physical no-follow traversal、dev/ino handshakes、parent fsync、final absence validation | synchronized nested symlink race preserves outside/sibling | verified |
| FR-18 coherent status | one borrowed authenticated repository snapshot、sanitized verifier issues、authoritative failure category、nullable untested write capabilities | verify-failure/malformed history/RPO/capability/mixed partial+malformed tests | verified |
| FR-19 CLI automation | strict v1 config、single JSON result、stderr code、category exit；valid no-repository legacy fallback | malformed config、service failure、integrity exit 15、legacy integration | verified |

#### T3 Findings 闭环与修复轮次

| ID / Round | Severity | 问题簇 | 修复证据 | 最终状态 |
|---|---|---|---|---|
| T3-R1-1 | Critical | path-based recursive delete 可在目录竞态中越过 quarantine | bound cwd + `/usr/bin/find -P -x` physical traversal + identity/ack/fsync | fixed |
| T3-R1-2 | High | malformed v1 config 静默 fallback 到 legacy/default status | `loadConfigStrict` + stable configuration JSON/exit 10 | fixed |
| T3-R1-3-R1-7 | Medium | mixed snapshots、verify issue suppression、stale consent、duplicate metadata、vacuous coverage、write capability false claim | single snapshot、exact fingerprint/time、unique metadata、complete=false、nullable untested fields | fixed |
| T3-R2-1 | Medium | failure state 仍从 leading partial issue 派生 category/exit | authenticated report category authoritative；matching integrity issue promoted | fixed |
| Withdrawn | — | same-size post-publication corruption 应否改变 structural healthy | confirmed MRD 明确定义 structural/content 分层；保留现有契约 | no bug |

| 轮次 | 结论 | 关键结果 | 验证 |
|---|---|---|---|
| R1 | BLOCKED | 1 Critical + 1 High + 5 Medium；删除竞态、status/validation/coverage 缺口 | 19 focused baseline |
| R2 | BLOCKED | 七项关闭；发现 mixed partial+malformed failure category 错配 | 26 focused + typecheck |
| R3 | APPROVED | authoritative failure category + primary issue/CLI exit 15；无 open C/H/M | 29 focused；239 full；status 9/9；typecheck/build/Biome |

#### T3 自动化、风险、限制与 ReviewerContribution

| 检查项 | 结果 | 证据 |
|---|---|---|
| Focused | PASS | 29/29 T3 focused；final status 9/9 |
| Full regression | PASS | 36 files / 239 tests |
| Type / Build | PASS | `pnpm typecheck`；`pnpm build` |
| Lint | PASS | direct Biome 111 files |
| Diff / Ownership | PASS | `git diff --check`；仅 T3 owned code/tests + parent-owned plan/review |
| Security | PASS | no shell interpolation；cwd-bound workers；bounded output/time；sanitized diagnostics；no raw paths/secrets |

- **回滚**：revert T3 task commit；不得手工删除 repository recovery point 或 quarantine residue；retention 失败保持 degraded 并保留诊断。
- **观测**：verify/status/retention 均输出 stable category、coverage/counts、next action；content failure 与 structural health 不混淆。
- **Known limitation**：Node stdlib 无 `openat/unlinkat`；Apple Silicon/macOS 删除使用系统 physical traversal 并在已绑定 cwd、父目录身份和 fsync 边界内 fail closed。root command wiring 延后到 T8。
- **Knowledge Impact**：none；本轮结论均为当前 MRD/plan/实现特定 hardening，没有独立 reusable lesson。

| Reviewer | Role | Scope | Findings | Verification | Knowledge Impact |
|---|---|---|---|---|---|
| anvil-doer-t3 | implementation | T3 accepted write set | 关闭全部 finding | 29 focused / 239 full | none |
| anvil-reviewer-t3 | independent adversarial review | verify/retention/status/CLI/races | R1-R2 BLOCKED；R3 APPROVED | 26 focused；final status 9/9 | none |
| anvil-lead | final arbiter | spec adjudication、ownership、compound、task boundary | accepted | full/type/build/Biome/diff | none |

#### T3 CompoundResultV2

```text
Action: submit
Mode: apply
Scope: T3 verification, health, retention and status
Candidates: 0
Active: 0
Draft: 0
Conflicts: 0
Operations: 0
Writes: 0
Deletes: 0
Validation: Collect pass (review-auto); Select no candidates because docs/anvil/knowledge is absent; Rank skip; Inspect Evidence pass for current MRD/plan/code/tests/review; Decide no reusable candidate; Validate pass/not-applicable including conflicts, sensitive data, links, schema and plan_drift; Apply skipped because zero operations; Revalidate skipped because zero-write
Decision: no-reusable-lesson
```

### 21. T4 staging、apply 与 rollback 评审补充

#### T4 摘要、边界与结果

- **一句话结论**：T4 经八轮独立对抗复核后通过终审，当前无未解决 Critical / High / Medium finding。
- **Before / After**：从 legacy 原路径直接 restore，升级为认证 point selection、确定性 staging、reviewed plan fingerprint、默认 dry-run、显式 apply、Safety Point、durable journal、可恢复 retry 与显式 rollback。
- **Accepted Write Set**：`src/recovery/**`、`src/cli/restore.ts`、`src/cli/apply.ts`、`tests/recovery/**`、`package.json` 的 Vitest timeout 预算，以及 parent-owned plan/review 状态。
- **非目标**：T4 命令暂不 root-wire；legacy copy migration 由 T5；新 Mac app inventory/recovery plan 由 T6；统一 CLI/package/docs 由 T8。

#### T4 需求—实现—验证映射

| Requirement / Success Criterion | Implementation | Verification | 状态 |
|---|---|---|---|
| 默认不写原路径 | authenticated point browse/selection + deterministic staging；apply/rollback 默认 dry-run | CLI contract、staging immutability tests | verified |
| reviewed destructive set | target/status/full expected identity、external parent、policy 进入 fingerprint/applyId 与 authenticated Safety intent | dry-run identity、parent ABA、pending/unchanged drift tests | verified |
| Safety Point 与 crash resume | intent → verified blobs → final manifest → protection；strict lifecycle child set；durable apply/rollback journals | pre-manifest、post-manifest/pre-protection、post-Safety、lost-ack tests | verified |
| 原子 apply 与 rollback | cwd/fd-bound file/symlink/hardlink/directory workers；preflight callbacks；per-entry identity checks | target/ancestor ABA、cross-blob corruption、directory ack tests | verified |
| metadata fidelity | whole-entry inode binding；portable/native cutoff；directory ancestor promotion；xattrs/flags explicit loss | two-xattr、portable→flags、fd-bound race、directory timestamp rollback | verified |
| bounded complexity | Safety lease 固定 4 FD、bounded full phases、Map O(1) artifact lookup、逐 entry blob 检查 | 16-file passive-metrics scale regression | verified |
| secret-safe failure | strict authenticated schemas、generic residue diagnostics、no secret paths/entry IDs | malformed/tamper/wrong-AAD tests | verified |

#### T4 Findings 闭环与修复轮次

| Round | 主要 finding | 修复结果 | 结论 |
|---|---|---|---|
| R1-R3 | encrypted Safety retry、descriptor auth、hardlink resume、directory/metadata ABA、mapping parent、lost ack、error category | canonical descriptor binding、durable expectations、fd-bound mutation、external-parent binding、structured publication outcomes | BLOCKED 后全部 fixed |
| R4-R5 | plan expected/status 未绑定、rollback tombstone、unchanged/pending TOCTOU、directory promotion、incomplete Safety adoption | authenticated planItems、contextual tombstone、final unchanged checks、ancestor promotion、strict intent design | BLOCKED 后全部 fixed |
| R6-R7 | final lifecycle exactness、no-journal semantic validation、implicit intent resume、Safety-root TOCTOU、intent auth、lease O(N²)/FD pressure | exact lifecycle、explicit applyId resume、full before-state checks、preflight callbacks、bounded lease | BLOCKED 后全部 fixed |
| R8 | executable observer 可重开跨 blob race；linear scan 仍为 O(N²) | 移除 public callback；passive metrics；`artifactByName` Map | **APPROVED** |

#### T4 自动化、风险与 ReviewerContribution

| 检查项 | 结果 | 证据 |
|---|---|---|
| Recovery | PASS | 49 recovery service + 9 recovery CLI = 58/58 |
| Full regression | PASS | 297/297；non-recovery 239/239 |
| Type / Build | PASS | `pnpm typecheck`；`pnpm build` |
| Lint / Diff | PASS | direct Biome 121 files；`git diff --check` |
| Complexity / FD | PASS | fixed 4 held FDs；constant control reads；linear Map probes |
| Security | PASS | exact authenticated intent/manifest/AAD；zero-mutation corruption preflight；secret-safe issues |

- **回滚**：revert T4 task commit；不得手工删除 active Safety Point、journal 或 incomplete intent residue；使用同一显式 apply ID retry，或显式 rollback。
- **观测**：apply/rollback 结果稳定区分 destination、integrity、configuration、partial；ambiguous publication 给出人工检查与同 ID retry 指引。
- **Known limitation**：同 UID 的任意非协作恶意进程不属于可完全阻止的 filesystem threat；生产路径通过无 callback commit、原子 worker、严格 preflight/identity checkpoint fail closed。creation time 和 symlink native metadata 无安全 object-bound 路径时显式 fidelity loss。
- **Knowledge Impact**：none；本轮结论均为当前 recovery state machine 的实现特定 hardening，zero-write compound。

| Reviewer | Role | Scope | Findings | Verification | Knowledge Impact |
|---|---|---|---|---|---|
| anvil-doer-t4 | implementation | T4 accepted write set | 关闭全部 finding | 58 recovery / 297 full | none |
| anvil-reviewer-t4 | independent adversarial review | Safety、apply/rollback、TOCTOU、metadata、complexity | R1-R7 BLOCKED；R8 APPROVED | 49 focused + type/Biome | none |
| anvil-lead | final arbiter | plan trace、ownership、compound、task boundary | accepted | full/type/build/Biome/diff | none |

#### T4 CompoundResultV2

```text
Action: submit
Mode: apply
Scope: T4 recovery staging, apply and rollback
Candidates: 0
Active: 0
Draft: 0
Conflicts: 0
Operations: 0
Writes: 0
Deletes: 0
Validation: Collect pass (review-auto); Select no candidates because no knowledge root exists; Rank skip; Inspect Evidence pass for current MRD/plan/code/tests/review; Decide no reusable candidate; Validate pass/not-applicable including conflicts, sensitive data, links, schema and plan_drift; Apply skipped because zero operations; Revalidate skipped because zero-write
Decision: no-reusable-lesson
```

### 22. T5 legacy 读取、恢复与复制迁移评审补充

#### T5 摘要、边界与结果

- **一句话结论**：T5 经独立对抗复核和最终 metadata-fidelity 窄修复后通过，当前无未解决 Critical / High / Medium finding。
- **Before / After**：从不可验证的 legacy snapshot 目录直接访问，升级为 strict 0.1.x read-only detect/list/restore，以及默认 dry-run、显式 copy-only、逐 point 验证和可中断重试的 v1 migration。
- **Accepted Write Set**：`src/migration/**`、`src/cli/migrate.ts`、migration tests；以及 migration-wide delegated lock 与 fully-covered metadata override 所需的 `src/repository/lock.ts`、`src/repository/index.ts`、`src/engine/v1-backup.ts` 及对应测试。
- **非目标**：不删除 legacy 源；不 root-wire 命令（T8）；不提供任意 installer framework（T6）。

#### T5 需求—实现—验证映射

| Requirement / Success Criterion | Implementation | Verification | 状态 |
|---|---|---|---|
| strict 0.1.x read-only scan | no-follow cwd-bound worker、bounded enumeration/hash、before/after logical+physical identity digest | malformed/symlink/FIFO/oversize/ABA/Unicode tests | verified |
| safe legacy restore | reviewed source identity digest、non-broad destination、default dry-run、atomic publish、never overwrite/delete | retry/reconciliation/destination-parent ABA tests | verified |
| explicit copy migration | exact safe logical sources、capacity overhead、physical overlap preflight、private immutable staging | empty-leaf/all-empty/space/overlap/source-unchanged tests | verified |
| only public v1 writer | `createV1RecoveryPoint` 发布；逐 point healthy verify；final expected-set + selector-all verify | interrupted retry/orphan pending/bad visible point/content verification tests | verified |
| migration-wide exclusion | repository-bound unforgeable delegated lease；writer validates but never releases caller lock | forged/released/cross-repo/replaced lease and concurrent writer/retention/migration tests | verified |
| exact legacy metadata | authenticated all-entry override coverage；serialized metadata exactly `mode/size/modifiedAtNs` | 0600/0700 decrypted-manifest exact-object and normal-backup parity tests | verified |
| stable CLI automation | FR-19 counts/timestamps/scope/results；category/exit preserved | configuration/source/destination/integrity CLI tests | verified |

#### T5 Findings 闭环与修复结果

| 问题簇 | Severity | 修复证据 | 最终状态 |
|---|---|---|---|
| manifest provenance 不精确、missing verify 被忽略、final set 未断言 | High / Medium | 全 entry path/type/mode/mtime/size/hash 比对；仅 `healthy` 通过；final expected/repository set 重验 | fixed |
| unbounded enumeration、empty branch 遗漏、capacity 低估、retry bound 过小 | Medium | streamed cap、empty leaf representation、entry/source/manifest overhead、10k authenticated discovery | fixed |
| source/destination path ABA 和 source-root symlink | High / Medium | root pre-canonical symlink reject、cwd/inode/time-bound workers、parent identity checkpoints | fixed |
| migration 多 point 间无全程独占锁 | High | canonical repository-bound WeakMap capability；发现前 acquire，final verify 后 release | fixed |
| staging metadata 合并泄漏 `createdAtNs`/xattrs/flags | Medium | override 改为 exact fresh `{mode,size,modifiedAtNs}` object；加密 manifest 精确断言 | fixed |
| CLI 错误分类被统一改写 | Medium | 保留 service category/exit；仅 config resolution 映射 configuration/10 | fixed |

#### T5 自动化、风险与 ReviewerContribution

| 检查项 | 结果 | 证据 |
|---|---|---|
| Focused | PASS | final expanded 76/76；reviewer independent 67/67 |
| Full regression | PASS | 41 files / 326 tests |
| Type / Build | PASS | `tsc --noEmit`；`pnpm build` |
| Lint / Diff | PASS | direct Biome 130 files；`git diff --check` |
| Security / Fidelity | PASS | bounded no-follow I/O；source zero-write audit；exact authenticated provenance；full-lifecycle lock |

- **回滚**：revert T5 task commit；不删除 legacy 源、已发布 v1 recovery point 或 pending 诊断残留。
- **观测**：migration 输出 stable category/code、source/point counts、scope、timestamps、per-point outcome 与 final verification。
- **Known limitation**：legacy all-empty point 无法构造安全非 broad logical source，因此显式 unsupported；不推断或删除源。
- **Knowledge Impact**：none；结论均为当前 migration contract 的实现特定 hardening，zero-write compound。

| Reviewer | Role | Scope | Findings | Verification | Knowledge Impact |
|---|---|---|---|---|---|
| anvil-doer-t5 | implementation | T5 accepted write set | 关闭全部 finding | 76 focused / 326 full | none |
| anvil-reviewer-t5 | independent adversarial review | scanner/restore/migration/provenance/lock/metadata/CLI | final APPROVED；0 open C/H/M | 67 focused + type/Biome/diff | none |
| anvil-lead | final arbiter | plan trace、ownership、compound、task boundary | accepted | full/type/build/Biome/diff | none |

#### T5 CompoundResultV2

```text
Action: submit
Mode: apply
Scope: T5 legacy read, restore and copy-only v1 migration
Candidates: 0
Active: 0
Draft: 0
Conflicts: 0
Operations: 0
Writes: 0
Deletes: 0
Validation: Collect pass (review-auto); Select no candidates because no knowledge root exists; Rank skip; Inspect Evidence pass for current MRD/plan/code/tests/review; Decide no reusable candidate; Validate pass/not-applicable including conflicts, sensitive data, links, schema and plan_drift; Apply skipped because zero operations; Revalidate skipped because zero-write
Decision: no-reusable-lesson
```

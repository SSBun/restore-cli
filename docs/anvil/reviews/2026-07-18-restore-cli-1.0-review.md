# 最终 MR 评审：`2026-07-18-restore-cli-1.0`

## 元数据

| 字段 | 值 |
|---|---|
| MR / Commit | T1 `87ef202`；T2 accepted working tree，task commit pending |
| Author | anvil-doer / anvil-lead |
| Review Date | 2026-07-18 |
| Review Writer | anvil-lead |
| Status | `APPROVED`（T1-T2 accepted write sets；完整 1.0 MR 仍 active） |

## 第一层：3 分钟读懂

### 1. Review 摘要

- **一句话结论**：T1 仓库/保护基础与 T2 来源/可验证备份均通过最终独立复核，当前无未解决 Critical / High / Medium finding。
- **为什么现在要改**：1.0 的备份、验证、恢复和调度都依赖同一个仓库身份、认证加密、锁和操作结果契约；基础错误会向所有后续任务扩散。
- **交付结果**：除 v1 repository/protection 外，新增 declarative source、严格 JSON plugin、metadata-faithful capture、contract-bound plaintext consent、verified pending point 与 cwd-bound atomic publication。
- **主要影响**：T1-T2 accepted write sets；CLI root wiring、health/retention、restore/migration/scheduler 仍由 T3-T9 完成。
- **Reviewer Action**：先看 T1 auth/identity/lock，再看 T2 `capture.ts` consistency、`stable-read.ts` metadata worker 与 `v1-backup.ts` publication/result boundary。

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
- **Rationale**：T1-T3 accepted write sets 满足 confirmed MRD/plan；全部对抗 finding 闭环，239 tests、typecheck、build、Biome 全绿，无 knowledge conflict。
- **Unresolved Items**：无 T1-T3 blocker；T4-T9 仍按 active plan 执行。
- **Knowledge Synchronization**：T1-T3 均 zero-write；`Decision: no-reusable-lesson`。
- **Resume / Next Action**：提交精确 T3 write set，然后自动开始 T4。

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

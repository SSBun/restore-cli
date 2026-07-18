# MRD / 工程 Spec：restore-cli 1.0.0 可信 macOS 环境恢复

## 执行元数据

- **Status**：confirmed
- **Workflow Stage**：req
- **Grill State**：complete
- **Created**：2026-07-18
- **Updated**：2026-07-18
- **Source Of Truth Until**：requirements are confirmed and replaced by an `/anvil:plan`, or the request is abandoned
- **Requirements Source**：用户在本次需求对齐中逐项确认的产品定位、安全模型、兼容性、恢复行为与发布边界；当前仓库代码/测试证据；官方一手资料研究
- **Background Inputs**：用户请求、现有 README/代码/测试、旧架构计划、[`docs/research/2026-07-18-recovery-tool-1.0-benchmark.md`](../../research/2026-07-18-recovery-tool-1.0-benchmark.md) 均为背景输入；本文是进入 `/anvil:plan` 前唯一规范性需求事实源
- **Compounded Knowledge**：not yet compounded

## 决策摘要

restore-cli 1.0.0 的产品承诺是：**在受支持的 Apple Silicon Mac 上，用户能够持续生成可验证的开发环境恢复点，并在当前 Mac 或新 Mac 上安全地恢复配置、识别缺失软件，且不会把不完整、损坏或写错目标的结果报告为成功。**

1.0 不是 Time Machine 替代品，也不是整机或个人文档备份工具。它聚焦个人开发者的 dotfiles、开发工具配置、应用偏好、密钥类配置和声明式软件清单。

已确认的关键产品决策：

| 维度 | 1.0 决策 |
| --- | --- |
| 产品定位 | Apple Silicon macOS 环境恢复；支持配置回滚和新 Mac 重建 |
| 数据范围 | 配置、偏好、开发工具状态和软件 inventory；不含个人大文件或整机镜像 |
| 加密 | 默认客户端认证加密；允许用户显式创建明文仓库 |
| 明文敏感源 | 允许，但新增或启用 `secret` 来源必须独立危险确认并持续显示 insecure |
| 密钥 | macOS Keychain 用于日常无人值守解锁；独立恢复凭据用于灾难恢复 |
| 旧仓库 | 0.1.x 明文仓库只读兼容；迁移为显式复制，不原地修改 |
| 目标存储 | 通过能力检查的已挂载文件系统：本地、外置盘、iCloud Drive、已挂载 SMB |
| 默认恢复 | 先恢复到 staging 并验证；显式 apply 后才写原路径 |
| 文件保真 | 用户空间文件、目录、隐藏条目、符号链接、硬链接、权限、时间戳、xattr、macOS flags |
| 源完整性 | 来源声明 required/optional；required 失败不得发布健康恢复点 |
| 软件恢复 | 默认只报告缺失项；用户显式选择后才可执行声明式安装器 |
| 调度与保留 | 默认每 12 小时备份，保留最近 14 个健康恢复点；24 小时无成功备份为 degraded |
| 平台 | 当前及前两个 macOS 大版本，仅 Apple Silicon |

## 背景输入

### 用户请求

- 为 `1.0.0` 发布定义一个可信恢复工具必须具备的全部关键能力。
- 进行外部研究并产出详细 MRD。
- 重点考虑失败、中断、恢复、迁移、安全和新 Mac 场景，而不是只列功能名称。

### 当前产品事实

- npm 包：`@ssbun/restore-cli@0.1.2`。
- CLI 已有 `config`、`backup`、`restore`、`tool`、`daemon`、`status`。
- 已有时间戳快照、未变化文件 hardlink、临时目录后 rename、最多 14 个快照、dry-run、按插件恢复和恢复到指定目录。
- 已有 Homebrew、VS Code、Raycast、Mac 应用等 inventory，但自动恢复范围有限。
- 当前仓库把目标当普通文件系统目录，缺少格式版本、仓库级 manifest、完整性验证、目标身份绑定、跨进程锁和加密。
- 当前恢复逐文件直接覆盖，未提供 staging → verify → apply 的完整事务边界。
- 当前扫描会遗漏部分隐藏目录和文件系统元数据；符号链接语义不明确。
- 当前 `skippedPaths` 不阻止快照发布，因此不完整备份可能仍显示成功。
- 当前后台进程不能证明重启后持续运行，也没有持久操作历史或可靠失败通知。

### 外部研究

研究仅使用官方一手资料：restic、BorgBackup、Kopia、Apple Time Machine、NIST、CISA 和 POSIX。完整比较见背景研究文档。

关键结论：

- restic、Borg 和 Kopia 都将仓库结构检查与完整内容读取验证区分开；成功备份不等于已证明可恢复。[restic](https://restic.readthedocs.io/en/stable/045_working_with_repos.html)、[Borg](https://borgbackup.readthedocs.io/en/stable/usage/check.html)、[Kopia](https://kopia.io/docs/advanced/consistency/)
- restic 明确警告原地恢复中断会留下部分状态；Kopia 提供逐文件原子写控制。[restic restore](https://restic.readthedocs.io/en/stable/050_restore.html)、[Kopia restore](https://kopia.io/docs/reference/command-line/common/snapshot-restore/)
- NIST 把备份完整性测试与实际恢复测试视为不同控制，并要求恢复到已知状态。[NIST SP 800-53 CP-9/CP-10](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final)
- CISA 建议加密、离线或隔离备份，并定期验证可用性和完整性。[CISA StopRansomware](https://www.cisa.gov/stopransomware/ransomware-guide)
- POSIX rename 的命名空间原子性不等于掉电后的持久性，且不能假设所有挂载文件系统具有等价保证。[POSIX](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap04.html)

## 工程理解

1.0 的核心不是增加更多内置插件，而是建立可验证的信任链：

```text
声明恢复范围
  → 验证来源与目标
  → 独占并一致地读取来源
  → 原子发布恢复点
  → 验证结构与内容
  → 安全列出和选择
  → staging 恢复
  → 验证 staging
  → 显式 apply
  → 验证目标环境
```

任一环节无法提供证据时，产品必须降级为 warning、partial、degraded 或 failure，不能继续显示等价的成功状态。

### 产品原则

1. **恢复优先于备份数量**：不能恢复的历史没有价值。
2. **失败关闭**：身份、密钥、完整性或 required 来源不确定时停止写入。
3. **默认可逆**：覆盖前先 staging、验证并保留当前状态。
4. **证据优先**：每个长操作产生可供人和机器消费的最终结果。
5. **不静默降级**：元数据、来源、目标能力或软件恢复损失必须报告。
6. **最小产品边界**：不重造整机备份、对象存储 SDK、App Store 自动化或完整包管理器。

## 用户与核心需求

### 主要用户

- 使用 Apple Silicon Mac 的个人开发者。
- 在 shell、Git、SSH、编辑器、Homebrew、Raycast 和其他开发工具中维护大量个人配置。
- 希望在误改配置、机器损坏或换新 Mac 后恢复工作环境。
- 能使用 CLI，但不应被要求理解仓库内部结构或手工判断快照是否健康。

### 非目标用户

- 需要企业多租户、集中策略、审计合规或远程管理员控制的组织。
- 需要 Windows/Linux 恢复的用户。
- 需要整机镜像、照片/视频归档、数据库一致性快照或裸机恢复的用户。
- 希望工具自动登录 App Store、下载任意 DMG 或恢复许可证的用户。

### Jobs To Be Done

| JTBD | 用户结果 |
| --- | --- |
| 配置回滚 | 找到一个确定的健康恢复点，查看变化，安全恢复选定配置 |
| 新 Mac 重建 | 在空白用户环境中连接仓库、解锁、恢复配置并得到缺失软件清单 |
| 自动保护 | 无人值守生成恢复点，并及时知道自动备份已过期或失败 |
| 灾难验证 | 在真正故障前证明仓库和恢复凭据可用 |
| 历史迁移 | 升级 1.0 后仍能读取 0.1.x 历史，且迁移失败不损坏原始备份 |

## 目标

### G1：可信恢复点

- 每个可选择恢复点都有稳定 ID、格式版本、来源清单、完整性元数据、创建结果和保护级别。
- 只有 required 来源完整、commit 完成且结构检查通过的恢复点才能成为 `latest healthy`。

### G2：安全恢复

- 默认恢复不覆盖当前环境。
- 用户能预览、staging、验证、应用、重试和回滚。
- 中断不能把截断文件呈现为成功恢复的文件。

### G3：空白新机可恢复

- 不依赖原 Mac 的本地配置、缓存或 Keychain，用户可凭仓库位置和离线恢复凭据开始恢复。
- 默认恢复配置并报告缺失软件；声明式安装只能显式启动。

### G4：自动备份可运营

- 计划在登录/重启后继续有效。
- 失败、过期、目标缺失和 partial 状态可见且可机器判断。

### G5：安全与兼容

- 默认加密和认证；明文例外明确、持续可见。
- 0.1.x 历史保留读取与恢复能力。
- 当前及前两个 macOS 大版本的 Apple Silicon 组合有明确验证证据。

## 非目标

- 不备份整机、系统卷、用户照片、视频、文档库或任意大目录。
- 不替代 Time Machine、restic、Borg 或 Kopia 的通用备份职责。
- 不支持 Intel Mac、Windows 或 Linux。
- 不实现 S3、WebDAV、云对象存储或未挂载 NAS 的原生协议客户端。
- 不自动安装 Mac App Store 应用、DMG、PKG、未知下载源或许可证。
- 不承诺 root ownership、完整 ACL、设备文件、socket、FIFO 或系统级特殊文件保真。
- 不在 1.0 提供多租户、中央管理服务、GUI、远程控制面或多机共享写仓库。
- 不在 1.0 提供不可变对象锁、append-only 远端、纠删码或仓库取证修复。
- 不承诺应用数据库的业务一致性或运行中应用的事务快照。

## 当前架构约束

### 必须保留

- TypeScript strict mode、Node.js `>=20`、ESM。
- `commander` CLI 与 `@clack/prompts` 交互模式。
- 成功输出 stdout、错误输出 stderr。
- 所有破坏性命令支持 `--dry-run`。
- 用户插件继续采用 JSON 声明式模型；不得要求插件运行任意代码才能声明备份范围。
- 内置 inventory 可以运行受控 prepare/tool 动作，但必须受同样的 dry-run、日志与失败语义约束。

### 已知差距

| 当前行为 | 1.0 缺口 |
| --- | --- |
| 目录名即快照身份 | 缺少格式版本、manifest、稳定 ID 和内容完整性证据 |
| iCloud/local/SMB 统一当路径 | 缺少目标身份、挂载和能力检查 |
| hardlink/copy 平面目录 | 缺少加密、认证及明确元数据模型 |
| `skippedPaths` 后仍发布 | 可能把不完整数据标为成功 |
| 恢复直接 `copyFile` | 中断和部分失败无法安全回滚 |
| daemon 内部 `running` 标志 | CLI 与 daemon、多个进程之间仍可并发 |
| PID worker | 无法证明登录/重启后持续调度和失败可见性 |
| 只处理普通内容 | 隐藏目录、链接和 macOS 元数据保真不足 |
| 内置插件 loader | 与项目声明的用户 JSON 插件契约不完整 |

## 方案选择

### S1：恢复仓库是显式产品对象

1.0 仓库必须有版本、唯一身份、保护模式、创建时间、支持能力和健康状态。路径本身不是仓库身份。

### S2：默认加密，明文为持续可见的例外

- 新仓库默认客户端认证加密，内容和敏感元数据在离开本机前受保护。
- 用户可显式创建明文仓库。
- 明文仓库状态始终显示 insecure。
- `secret` 来源加入明文仓库时需要独立危险确认；该风险接受必须可审计和撤销。

### S3：staging 与 apply 分离

- restore 阶段只生成可验证 staging 结果。
- apply 是独立、显式、可 dry-run 的破坏性阶段。
- apply 前保存当前状态；apply 后验证最终结果。

### S4：能力型已挂载目标

- 支持本地目录、外置卷、iCloud Drive 和已挂载 SMB。
- 具体标签不能替代能力验证。
- 目标丢失或身份不匹配必须失败，不能创建同名替代目录。

### S5：恢复配置为默认，软件安装为显式可选

- 默认输出缺失应用、包和扩展，不执行安装。
- 只有用户显式选择后，才可运行已声明、可审计、支持 dry-run 的安装器。

## 被排除方案

| 方案 | 排除原因 |
| --- | --- |
| 整机/个人数据备份 | 与现有插件和配置恢复架构不匹配，且会引入大文件、分块、带宽和裸机恢复责任 |
| 强制所有仓库加密 | 用户明确要求保留明文选择 |
| 仓库级一次确认后允许所有 secret | 用户确认需要新增/启用 secret 时独立危险确认 |
| 自动原地升级 0.1.x | 会修改用户可能唯一的可读备份，缺少安全回滚路径 |
| 默认原地恢复 | 中断或选择错误会直接损坏当前工作环境 |
| 原生 S3/WebDAV | 不是 1.0 目标，已挂载文件系统能力检查覆盖现有用例 |
| 全自动应用安装 | 账号、许可证、未知下载和不可逆副作用超出可信边界 |
| 永久只报告软件 | 用户确认保留显式受控的声明式安装能力 |
| Intel 支持 | 用户明确限定 Apple Silicon |
| 复杂 GFS 保留 | 14 个健康恢复点已经满足 1.0 最小滚动历史，复杂日/周/月策略后置 |

## 领域语言

| 术语 | 定义 |
| --- | --- |
| Repository / 仓库 | 包含格式元数据、恢复点、完整性信息和保护配置的备份集合 |
| Recovery Point / 恢复点 | 一次已发布的不可变环境状态；不能仅用目录存在表示完整 |
| Healthy | required 来源完整、commit 完成、结构验证通过且仓库可解锁 |
| Partial | 存在已声明的数据或保真损失；不得替代 `latest healthy` |
| Degraded | 当前仍有可恢复数据，但自动备份新鲜度、目标或验证状态不满足策略 |
| Required Source | 缺失、不可读或不稳定时会阻止发布健康恢复点的来源 |
| Optional Source | 缺失可接受，但必须记录在结果和 manifest 中的来源 |
| Secret Source | 可能包含私钥、恢复密钥、token 或等价长期凭据的来源 |
| Staging | 恢复到隔离目录、尚未覆盖真实配置的可验证结果 |
| Apply | 将已验证 staging 结果显式写入真实目标路径的阶段 |
| Safety Point | apply 前捕获的当前状态，用于回退本次恢复 |
| Structural Verify | 验证 manifest、索引、引用、对象存在性和仓库结构一致性 |
| Content Verify | 读取并认证/哈希实际存储内容，而非只判断对象存在 |
| Recovery Drill | 从干净用户环境完成连接、解锁、列出、恢复、应用和验证的演练 |
| Declarative Installer | 输入和动作可预览、可审计且非交互契约明确的安装器，例如 Homebrew/VS Code CLI |

## Knowledge Probe

- **Policy Source**：项目 `AGENTS.md`、Anvil `/anvil:req` 启动规则和 `rules/lightweight.md`。
- **Actual Invocation**：2026-07-18 在项目根目录检查 `docs/anvil/knowledge/`，并准备按 `backup|restore|recover|snapshot|integrity|release|plugin` 做 frontmatter/body 检索。
- **Candidate Ranking**：0 个候选；`docs/anvil/knowledge/` 不存在。
- **Active Matches**：0。
- **Draft Clues**：0。
- **Relevant Conflicts**：0。
- **Unrelated Conflicts**：0。
- **Decision**：`continue`。知识库缺失非阻塞；当前用户确认、代码、测试和官方研究优先。

## 功能需求

以下优先级定义：

- **P0**：缺失则不能宣称 1.0 是可信恢复工具。
- **P1**：应进入 1.0；可在 release candidate 阶段基于证据降级，但必须显式重新确认范围。
- **P2**：明确后置，不阻塞 1.0。

### FR-01 仓库初始化与身份（P0）

1. 初始化必须要求明确目标路径，展示目标类型、卷/挂载身份、保护模式和预期空间。
2. 初始化必须创建唯一仓库身份和显式格式版本。
3. 后续命令必须同时校验路径、仓库身份和目标能力。
4. 已配置仓库路径不存在时必须失败；不得自动创建可能落到本机系统盘的替代目录。
5. marker 缺失、身份变化、仓库版本不支持或目标只读时，必须在写入前失败。
6. 同一路径出现非 restore-cli 数据时，不得自动接管、删除或覆盖。

验收：

- 拔掉外置卷或断开 SMB 后运行 backup，不在原挂载点创建新目录。
- 用另一个仓库替换同一路径时，身份检查失败。
- 支持目标通过写入、原子发布、读回、锁和清理能力检查。

### FR-02 仓库保护与凭据（P0）

1. 新仓库默认启用客户端认证加密。
2. 内容和敏感元数据必须在写入目标前受保护。
3. 错误凭据或认证失败不得产生目标写入。
4. 密码、恢复凭据和明文密钥不得出现在 argv、日志、错误文本或 JSON 输出。
5. 日常自动备份通过绑定仓库身份的 macOS Keychain 凭据解锁。
6. 初始化必须引导用户导出独立恢复凭据，并执行一次重新导入/解锁验证。
7. 恢复凭据不能默认存入仓库目录。
8. 必须支持凭据轮换和撤销，且不能要求重写全部历史数据作为产品前提。
9. 丢失全部有效凭据时必须明确说明仓库不可恢复。

明文例外：

- 用户可显式创建明文仓库，但必须看到保护范围和风险。
- 状态、backup、verify、restore 和 recovery plan 都必须显示 `unencrypted/insecure`。
- 新增或启用 `secret` 来源需要独立确认，不得继承仓库初始化时的一次性确认。
- 风险接受需记录时间、来源和仓库，不记录 secret 内容。

### FR-03 插件与来源契约（P0）

1. 内置与用户 JSON 插件使用一致的声明式来源模型。
2. 每个来源必须声明：逻辑名称、路径、required/optional、敏感等级、预期条目类型和恢复范围。
3. 未声明敏感等级时按更敏感等级处理。
4. 路径展开后的实际范围必须显示在 config validate 和 backup dry-run 中。
5. 重叠来源必须去重或明确报告，不得造成同一路径的冲突恢复语义。
6. 插件路径不得通过 `..`、符号链接或运行时变化逃逸已确认范围。
7. 用户插件不得默认执行任意代码；可执行 prepare/tool 必须来自受信任、可识别来源并有独立权限边界。
8. `config validate` 必须发现未知插件、重复来源、无效路径、危险 root 范围和不兼容来源类型。

### FR-04 来源扫描与一致性（P0）

1. 扫描不得默认忽略隐藏文件或隐藏子目录。
2. 支持普通文件、目录和符号链接，且符号链接默认按链接对象保存，不跟随到声明范围之外。
3. required 来源缺失、不可读或无法稳定读取时，不得发布健康恢复点。
4. optional 来源缺失可继续，但必须进入 manifest 与最终结果。
5. 备份期间发生大小、内容或元数据变化时，必须重试到明确上限或标记失败/partial；不能静默采用不一致内容。
6. 同一应用需要多个相关文件时，插件必须能声明一致性组；无法获得一致视图时不得声称应用级一致。
7. 空目录是否纳入恢复必须由来源契约决定，不能依赖扫描偶然行为。

### FR-05 文件与元数据保真（P0）

支持范围：

- 普通文件与目录。
- 隐藏条目。
- 符号链接和硬链接关系。
- 用户可设置的 mode/权限。
- 创建/修改相关时间戳中可移植、可安全恢复的部分。
- macOS xattr 和 flags。

要求：

1. manifest 必须记录支持的条目类型和元数据。
2. staging verify 必须比较内容和已承诺元数据。
3. 权限不足或目标文件系统不支持时，必须逐项报告 fidelity loss。
4. fidelity loss 返回 warning/partial，不能显示为完全成功。
5. ownership、完整 ACL、特殊文件和 root-only 元数据明确不在 1.0 保证内。

### FR-06 备份计划与 dry-run（P0）

1. dry-run 必须执行不产生真实写入的来源解析、目标检查、空间估算、冲突检查和变化计划。
2. dry-run 不运行会修改 inventory 或外部状态的 prepare 动作；需要动态 inventory 时使用只读检查或标明执行阶段。
3. 计划至少显示：仓库、保护模式、上一个 healthy ID、插件、required/optional 状态、预计新增/复用/跳过/失败、空间需求和任何风险。
4. dry-run 与真实执行必须共享同一决策逻辑，避免选择集合漂移。

### FR-07 独占、事务与恢复点发布（P0）

1. backup、migrate、prune、verify full 和其他写/维护操作必须遵守明确的共享/独占并发规则。
2. CLI、scheduler 和多个进程之间必须使用仓库级锁，不能只使用进程内布尔值。
3. 锁必须包含 owner、operation、start time 和可诊断身份。
4. stale lock 只能在证明 owner 不存在或用户显式确认后清理。
5. 中断操作不得出现在可选择的恢复点列表中。
6. required 内容、manifest 和完整性信息均可达后，恢复点才可原子发布。
7. 发布失败必须清理或隔离临时状态；清理失败不能掩盖原始错误。
8. 相同恢复点 ID 冲突时必须失败，不得合并两个执行结果。

### FR-08 恢复点 manifest 与健康状态（P0）

每个恢复点至少记录：

- 稳定 ID、仓库格式版本、创建起止时间。
- 源主机标识、macOS 大版本、Apple Silicon 架构和 CLI 版本。
- 插件及解析后的来源集合。
- required/optional、敏感等级和保护模式。
- 条目类型、内容完整性引用和已保存元数据。
- skipped、warning、partial 与 failure。
- 上一健康恢复点引用（如适用）。
- 发布和验证状态。

`latest` 必须解析并打印具体 ID；`latest healthy` 不得指向 partial、failed、未验证或不可解锁恢复点。

### FR-09 结构与内容验证（P0）

提供两个可区分的只读验证级别：

1. **Structural**：验证仓库身份、格式、manifest、引用、对象存在、恢复点可遍历和索引一致性。
2. **Content**：读取选定覆盖范围的实际存储内容，完成认证/哈希和解码验证。

要求：

- 输出必须说明验证级别、覆盖恢复点、覆盖文件/字节、跳过项、成本和最终状态。
- 任一不可验证 required 内容返回非零状态。
- verify 不得默认修复、删除或重新写入仓库。
- repair/salvage 不进入 1.0；诊断结果必须保留证据并给出安全下一步。
- 支持对单个恢复点、latest healthy 和整个仓库执行验证。
- 定期自动备份不能把一次浅层结构检查描述成完整恢复演练。

### FR-10 恢复点发现与选择（P0）

1. 能在没有本地 config/cache 的新用户环境中连接仓库。
2. 能列出 ID、时间、源主机、插件、保护模式、健康和验证状态。
3. 支持查看恢复点内的插件、路径和变更摘要。
4. 默认只能选择 healthy 恢复点；选择 partial/legacy 必须显式确认并展示限制。
5. 对 `latest` 的使用必须显示解析后的不可变 ID。

### FR-11 staging 恢复（P0）

1. 默认恢复目标是独立 staging 目录，不是原路径。
2. 恢复前展示固定 snapshot ID、来源、目标、插件/路径范围和保护状态。
3. 支持全配置、单插件和选定路径恢复。
4. 每个输出文件必须以原子文件边界发布；中断不能留下被误认为完整的截断文件。
5. staging 结果必须验证内容及承诺的元数据。
6. 最终结果区分 restored、unchanged、skipped、conflicted、failed 和 fidelity loss。
7. 中断后重新运行应收敛，不要求用户先删除未知临时文件。

### FR-12 apply、冲突与回滚（P0）

1. apply 是独立破坏性动作，必须支持 dry-run。
2. apply 前创建 Safety Point，记录当前将被影响的文件和元数据。
3. 默认冲突策略不得静默覆盖；用户必须选择 overwrite、skip 或限定范围。
4. 不允许隐式删除目标中额外文件。
5. 每个文件原子替换；单项失败不得伪装成整次成功。
6. apply 中断后应可重试；已应用、未应用和失败项必须明确。
7. Safety Point 至少保留到 apply 和 post-apply verify 成功。
8. 提供回退本次 apply 的明确路径，且回退也支持 dry-run 和结果报告。

### FR-13 新 Mac recovery plan（P0）

在干净用户环境中，用户仅凭以下声明依赖即可开始：

- 受支持的 Apple Silicon Mac 和 macOS。
- 可验证来源安装的兼容 restore-cli。
- 仓库位置。
- 仓库恢复凭据（加密仓库）。
- 访问目标存储所需的系统/网络权限。

流程必须覆盖：

1. 连接并验证仓库身份。
2. 解锁并检查恢复凭据。
3. 选择 healthy 恢复点。
4. 比较当前软件/配置状态。
5. 输出缺失应用、Homebrew 条目、VS Code/Raycast 扩展和手工依赖。
6. staging 恢复配置。
7. 验证 staging。
8. 显式 apply。
9. 执行 post-apply 功能检查并输出未完成事项。

流程不能依赖原 Mac Keychain、原本地 config 或原缓存。

### FR-14 声明式软件安装（P1）

默认行为：

- 只报告缺失软件和差异。
- 不自动运行安装命令。

显式 opt-in 后：

- 仅允许已声明、可审计、支持非交互结果判断的安装器，例如 `brew bundle`、`code --install-extension`。
- 必须先输出 dry-run/plan，再逐阶段确认。
- 不得由 daemon、普通 restore 或配置 apply 隐式触发。
- 记录每个条目的 installed、already-present、skipped、failed 和 manual-required。
- 中断后可从未完成条目继续，不重复破坏性步骤。

始终手工：

- Mac App Store 登录与购买。
- DMG/PKG 下载和执行。
- 未知来源应用。
- 许可证、账号登录和二次验证。

### FR-15 旧仓库读取与迁移（P0）

1. 1.0 能发现、列出、验证能力范围内的 0.1.x 快照并恢复。
2. legacy 仓库保持只读；普通 1.0 backup 不得写入 legacy 格式。
3. 迁移必须是显式 copy，不修改源仓库。
4. 迁移 dry-run 显示源/目标、空间、保护模式、可迁移恢复点和不支持项。
5. 迁移前检查目标能力和可用空间。
6. 中断迁移不发布不完整恢复点，并可安全重试。
7. 每个迁移恢复点完成结构和内容验证后才能成为 healthy。
8. 迁移完成后执行目标仓库完整性检查；源仓库删除永不自动发生。
9. 迁移前后都能使用原 0.1.x 快照恢复。

### FR-16 调度、RPO 与自动恢复（P0）

1. 默认调度间隔 12 小时，可配置；`0` 表示禁用。
2. 调度在受支持的登录/重启场景后继续有效，不要求用户每次手工 start。
3. 同一仓库不能出现重叠 backup。
4. 目标缺失时记录失败并等待下一次计划，不写替代路径。
5. 睡眠、断网或目标暂时不可用后，恢复条件满足时应按明确策略补跑或等待下一周期。
6. 24 小时无 successful healthy backup 时，仓库状态为 degraded。
7. scheduler 不得执行软件安装、apply、migration 或 destructive maintenance。

### FR-17 保留与清理（P0）

1. 默认保留最近 14 个 healthy 恢复点，可配置。
2. partial/failed/incomplete 不计入 healthy 保留数量，也不能触发删除 healthy 历史。
3. 永不自动删除最后一个 healthy 恢复点。
4. 清理必须支持 dry-run，展示 kept/removed/reason/estimated bytes。
5. 选择算法必须确定、可测试并限定当前仓库。
6. 清理使用独占锁，不与 backup、migration 或 full verify 并发。
7. Safety Point 在 apply 验证完成前受保护。
8. 删除失败产生 degraded/warning，但不能倒转已成功发布的新恢复点；必须保留明确结果。

### FR-18 状态、历史与通知（P0）

`status` 至少显示：

- 仓库身份、位置、保护模式、目标能力状态。
- scheduler enabled/running/degraded。
- latest healthy ID 与时间。
- 当前 RPO age、下次计划时间。
- 最近结构/内容验证时间和覆盖范围。
- healthy/partial/failed 恢复点数量。
- 最近操作结果与可执行下一步。
- legacy/migration 状态。

自动操作必须保留有限、可轮转的本地历史。无人值守失败、连续 degraded、目标身份变化和内容验证失败必须提供 macOS 本地通知或等价的明确用户可见信号。

### FR-19 CLI 自动化契约（P0）

1. 所有核心命令具有稳定退出分类：success、warning、partial、configuration、authentication、lock、source、destination、integrity、unsupported、cancelled、internal。
2. 未知非零退出状态必须被调用方视为失败。
3. 人类错误和进度写 stderr；明确的成功结果写 stdout。
4. backup、verify、restore、apply、migrate、status 提供机器可读最终结果。
5. 机器输出不能混入 TTY 动画或 prompt 文本。
6. 最终结果至少包含 operation、resolved recovery point ID、start/end、files/bytes considered/written/skipped/failed、verification scope 和稳定错误类别。
7. 非交互模式遇到需要确认的风险时失败，不得自动接受默认值。

### FR-20 平台与兼容性（P0）

1. 支持发布时当前及前两个 macOS 大版本，仅 Apple Silicon。
2. Intel Mac 必须在安装或首次运行时给出明确 unsupported，不得声称 best-effort 支持。
3. 仓库格式不得编码 CPU 相关路径或表示。
4. manifest 记录源 macOS 大版本、架构、CLI 与仓库格式版本。
5. 跨受支持 macOS 大版本恢复时，plan 必须识别不兼容应用、路径和元数据。
6. 新版本必须读取 1.0 仓库或安全拒绝写入并提供升级路径；不得静默升级仓库格式。

### FR-21 发布与恢复材料（P0）

1. npm 安装产物包含运行所需 CLI、脚本和文档，不含 stale build 文件。
2. CLI 入口在干净环境可执行并报告版本。
3. 用户可从仓库外获得离线/可打印 recovery checklist，列出所有不可替代依赖。
4. checklist 覆盖安装、连接、解锁、list、verify、staging、apply、post-verify 和求助信息。
5. 文档明确：加密不防止拥有写权限的客户端删除仓库；明文风险；凭据丢失后果；非目标文件类型；支持矩阵。

## 边界与失败模式

| 失败场景 | 必须行为 | 禁止行为 |
| --- | --- | --- |
| 外置盘未挂载 | 写入前失败，显示预期目标身份 | 在同一路径创建普通目录 |
| SMB/iCloud 中断 | 不发布不完整恢复点；保留可诊断状态 | 报告 success 或把临时目录当快照 |
| 目标空间不足 | preflight 或写入阶段失败，清理/隔离临时状态 | 删除健康恢复点后继续碰运气 |
| required 源缺失 | 阻止 healthy commit | 仅 warning 后替代 latest healthy |
| optional 源缺失 | 记录 warning 和 manifest | 静默忽略 |
| 文件备份中变化 | 重试或 partial/failure | 混合读取后报告一致 |
| 错误密码/认证失败 | 写入前失败 | 创建空仓库、修改恢复点或泄露凭据 |
| 仓库内容损坏 | verify 非零，restore 不报告完整成功 | 正常命令自动 repair |
| backup 被 kill | 无完整恢复点可见；可安全重跑 | 发布临时快照 |
| restore/apply 被 kill | 无截断文件被视为完成；报告 partial | 返回 0 或删除 Safety Point |
| stale lock | 诊断 owner 后显式清理 | 仅按时间自动删除未知锁 |
| 两进程并发 | 一个获得锁，另一个返回稳定 lock 状态 | 同时写相同仓库 |
| 明文新增 secret | 独立危险确认和风险记录 | 静默继承旧确认 |
| Keychain 丢失 | 可用离线恢复凭据重新连接 | 宣称仓库不可恢复而未检查恢复凭据 |
| 所有凭据丢失 | 明确不可恢复 | 提供虚假绕过或自动重置 |
| iCloud 文件未下载 | 恢复前 hydrate/验证或失败 | 把 placeholder 当真实内容 |
| 不支持元数据 | 逐项 warning/partial | 静默丢弃并报告完整成功 |
| legacy 迁移中断 | 源保持可读，目标无坏恢复点 | 原地修改或删除源 |
| 清理失败 | 新恢复点保持成功但仓库 degraded | 回滚已发布恢复点或吞掉错误 |
| 软件安装失败 | 配置恢复不回滚；列出 manual/failed | 自动继续未知安装或登录 |

## 非功能需求

### NFR-01 正确性

- 所有 P0 状态转换都有可执行测试或故障注入证据。
- 不允许“命令退出 0，但 required 数据缺失、内容未验证或目标身份错误”。
- 恢复计划、实际选择和结果之间可追踪到同一恢复点 ID。

### NFR-02 安全

- 加密模式提供机密性与篡改检测，而不只是混淆或目标盘权限。
- secret 通过安全输入通道提供，不经过 argv。
- 日志默认最小化敏感路径；机器输出不得包含密钥或文件内容。
- 自定义插件和外部安装器视为信任边界。

### NFR-03 可恢复性

- ordinary interruption 不破坏已有 healthy 恢复点。
- backup、restore、apply 和 migrate 可安全重试。
- 真实 restore drill 是 1.0 发布门禁，不以单元测试或结构检查代替。

### NFR-04 可观察性

- 任何无人值守操作有持久最终结果。
- 成功、warning、partial、degraded 和 failure 可由人和机器区分。
- 长操作有进度，但进度不破坏结构化结果。

### NFR-05 性能与资源

- 1.0 不设跨设备绝对 RTO，因为 iCloud/SMB 和外部安装下载不可控。
- 所有长操作报告文件数、字节数和耗时，使后续能建立实际基线。
- full content verify 允许用户选择恢复点/覆盖范围并明确预计成本，但不能以性能为由取消完整验证能力。
- 内存使用不应与所有文件内容总大小线性增长。

### NFR-06 可用性

- 危险操作默认回答为否，并能在 non-interactive 模式安全失败。
- 错误信息包含：发生了什么、哪些数据受影响、仓库是否仍健康、下一步是什么。
- 新 Mac 流程不要求用户手工浏览仓库内部目录。

### NFR-07 可维护性

- CLI 只承担参数、提示、输出和退出状态；核心行为可直接测试。
- 不新增第二套任务/状态系统；实现与验证由后续 Anvil plan DAG 管理。
- 仓库格式、CLI 输出和插件 schema 的兼容变化必须显式版本化。

## 安全关注点

### 威胁模型内

- 备份目标被其他用户读取。
- 网络/云同步目标不完全可信。
- 存储内容发生偶然损坏或未经授权修改。
- 用户误选目标、快照或覆盖范围。
- 已授权客户端误删或错误清理。
- 原 Mac 丢失，但仓库和独立恢复凭据仍可用。
- 自定义插件声明危险路径或越界链接。

### 威胁模型外但必须披露

- 完全控制源 Mac 的攻击者可备份已经被篡改的数据。
- 普通加密不能阻止拥有仓库写/删权限的攻击者删除全部备份。
- 明文仓库不提供应用层机密性或篡改认证。
- 用户丢失所有有效恢复凭据后，加密仓库不可恢复。
- 1.0 不提供不可变远端、离线副本自动管理或恶意软件清理。

### 隐私

- 不引入遥测、账号系统或云控制面。
- 操作历史默认仅保存在本机配置目录，且可轮转和删除。
- 文档/诊断导出默认不包含文件内容、secret、恢复凭据或完整敏感路径。

## 工程代价

本需求不是局部功能增强，而是跨 config、plugin、engine、restore、daemon、CLI、仓库格式、迁移、发布和测试的 1.0 可靠性重构。

后续 `/anvil:plan` 必须至少评估：

- 新仓库格式与 manifest 的版本/兼容策略。
- 加密与 Keychain/恢复凭据生命周期。
- 来源 schema、用户插件与 metadata 模型。
- 目标能力/身份抽象。
- 事务、锁、备份发布与恢复 staging/apply 状态机。
- structural/content verify。
- 0.1.x legacy reader 与 copy migration。
- scheduler 持久化、操作历史与通知。
- Apple Silicon macOS 测试矩阵与 fault-injection harness。
- npm 发布表面、recovery checklist 和真实恢复演练。

### 成本约束

- 不以“兼容旧内部函数”为由削弱仓库/恢复正确性；外部行为兼容优先。
- 不为 post-1.0 功能预建远端 provider、GUI、多租户或通用安装框架。
- 可以删除或替换无法满足 1.0 不变量的旧路径，但必须由 plan 明确迁移和回归范围。

## 显式假设

1. 主要备份数据是配置和 inventory，规模明显小于个人文档库。
2. 用户能够保管一个独立恢复凭据，并理解遗失凭据的后果。
3. iCloud Drive 和 SMB 通过 macOS 挂载后使用；1.0 不直接调用其远端 API。
4. Apple Silicon Mac 是唯一支持的 CPU 架构。
5. 发布时“当前及前两个 macOS 大版本”的具体版本号由 `/anvil:plan` 根据当时 Apple 稳定版固化。
6. 用户 JSON 插件是 1.0 产品契约；任意代码插件不是默认能力。
7. 声明式软件安装是显式 opt-in 的辅助步骤，不影响配置恢复是否成功。
8. 1.0 可把 repair/salvage 留到后续，但不能省略只读诊断和完整验证。
9. 用户仍需使用 Time Machine 或其他方案保护个人文档和整机数据。

## 成功标准

### 产品成功定义

用户能在受支持的新 Apple Silicon Mac 上，仅使用公开安装包、仓库位置和独立恢复凭据，完成：

```text
connect → unlock → list healthy → full verify selected point
→ generate recovery plan → report missing apps
→ restore to staging → verify staging → apply configs
→ verify applied state → receive final machine-readable result
```

### 1.0 发布硬门禁

- [ ] 所有 P0 需求有实现证据和测试映射。
- [ ] 当前及前两个 macOS 大版本的 Apple Silicon 支持矩阵已固化并通过验证。
- [ ] 从干净用户环境完成至少一次端到端 recovery drill。
- [ ] 用错误密码、缺失 Keychain 和独立恢复凭据分别验证正确行为。
- [ ] 0.1.x legacy 仓库可列出和恢复；copy migration 中断不损坏源。
- [ ] structural verify 能发现 metadata/manifest 损坏。
- [ ] content verify 能发现实际内容损坏或认证失败。
- [ ] backup 在内容写前、内容与 manifest 之间、最终发布前被中断时均不暴露坏恢复点。
- [ ] restore/apply 在大文件和元数据写入中被中断时不留下被报告为完整的截断文件。
- [ ] 目标满、只读、断线、身份变化、stale lock、并发进程和 required 源错误均有稳定非零结果。
- [ ] 隐藏条目、符号链接、硬链接、mode、timestamps、xattr 和 flags 有代表性 round-trip 测试。
- [ ] retention dry-run 与真实选择一致，且不能删除最后一个 healthy 或受保护 Safety Point。
- [ ] 明文仓库及 plaintext secret 的风险确认和持续 insecure 状态通过测试。
- [ ] scheduler 在支持的登录/重启场景恢复，且 24 小时过期会进入 degraded 并通知。
- [ ] npm 包从干净目录安装后，CLI、运行时脚本、版本输出和 recovery checklist 可用。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test` 全部通过。
- [ ] 安全评审未发现 secret 泄露、路径逃逸、未认证写入或静默明文降级。

### 质量指标

- P0 测试映射覆盖率：100%。
- 已知 required 来源静默遗漏：0。
- 已知坏恢复点被标记 healthy：0。
- 破坏性操作无 dry-run：0。
- 支持矩阵内真实 recovery drill 成功率：100%。
- 自动备份超过 24 小时未成功但未显示 degraded：0。
- secret 出现在 argv、日志或机器结果：0。

本项目不在 1.0 收集远程产品遥测；质量指标来自本地测试、release drill 和用户主动提交的脱敏问题报告。

## PR Review 关注点

后续评审必须逐项追踪：

1. 每个代码变更对应的 FR/NFR ID。
2. 仓库格式和插件 schema 的向后兼容影响。
3. 所有成功路径是否可能吞掉 partial、warning 或 fidelity loss。
4. 所有写入前是否完成目标身份、能力、锁和认证检查。
5. 临时状态是否可能被 list/restore 识别为完整。
6. secret 是否可能进入 argv、环境泄露、日志、错误或测试快照。
7. 符号链接、路径规范化和 staging/apply 是否能逃逸声明范围。
8. dry-run 是否与执行共享选择逻辑且确实零写入。
9. legacy reader 是否保持只读；migration 是否永不删除源。
10. scheduler、CLI 与 maintenance 是否共享仓库级并发规则。
11. unsupported Intel/OS/metadata 是否明确拒绝或报告，而非静默 best-effort。
12. release drill 是否使用真实 npm 产物和干净用户环境，而非源码工作区捷径。

## 开放问题

不存在阻塞 `/anvil:plan` 的产品问题。以下工程细节明确延后到规划阶段，不能改变本文产品边界：

| 问题 | Owner | 触发时机 | 延后原因 |
| --- | --- | --- | --- |
| 认证加密、KDF 和密钥封装的具体方案 | `/anvil:plan` + security review | 仓库格式设计 | 需要威胁模型与依赖评估，不是产品偏好 |
| manifest/schema 的具体字段编码 | `/anvil:plan` | 数据模型设计 | 本文已定义必须表达的语义 |
| 当前及前两个 macOS 的具体版本号 | release lead | plan 创建时 | 随 Apple 稳定版变化 |
| Keychain 条目和恢复凭据载体格式 | `/anvil:plan` | security architecture | 必须满足已确认生命周期，但实现形式待选 |
| 持久 scheduler 和本地通知的具体机制 | `/anvil:plan` | daemon design | 需要适配 macOS 支持矩阵 |
| full verify 的默认覆盖与性能预算 | `/anvil:plan` | verification design | 必须保留 100% 能力，默认成本需实测 |
| legacy copy migration 的空间估算算法 | `/anvil:plan` | migration design | 需求已规定 preflight 与源只读 |
| 声明式安装器的首批允许列表 | product owner + plan | recovery workflow design | 默认关闭；不得扩大到 DMG/App Store |

## 恢复点

- **Confirmed**：本文“决策摘要”中的全部产品选择均由用户逐项确认。
- **Evidence-resolved**：用户 JSON 插件契约来自项目 `AGENTS.md`；验证、原子发布、结构化结果和真实 recovery drill 来自当前代码缺口及官方研究基线。
- **Deferred**：仅“开放问题”表中的实现细节，均不得重开产品范围。
- **Next Action**：进入 `/anvil:plan` 设计架构与可执行任务 DAG。

# @ssbun/restore-cli

面向 Apple Silicon Mac 的可验证配置备份与恢复 CLI。它将配置文件写入版本化的 `RestoreBackup` 仓库，支持加密恢复点、完整性验证、隔离暂存、显式应用与回滚。

## 系统要求

- Apple Silicon Mac（`arm64`）
- macOS 14 Sonoma、15 Sequoia 或 26 Tahoe
- Node.js 20 或更高版本

Intel Mac、其他操作系统和不在支持范围内的 macOS 主版本会在执行前被拒绝。

## 安装

```bash
npm install -g @ssbun/restore-cli
restore-cli --version
```

## 快速开始

运行交互式配置，选择备份目标、周期和插件：

```bash
restore-cli config
```

向导会创建目标目录和明文 `RestoreBackup` 仓库，并自动保存仓库 ID。仓库内容不会加密；请只使用受信任的本地磁盘、加密卷或可信网络目标。包含 secret 来源的插件不会出现在默认明文配置中。随后检查并完成第一次备份：

```bash
restore-cli config validate
restore-cli backup --dry-run
restore-cli backup
restore-cli verify --latest-healthy --content
restore-cli status
```

## 安全恢复模型

恢复分成两步：先将已认证的恢复点写入隔离暂存目录，再显式应用到目标路径。`apply` 和 `rollback` 默认只生成计划，必须加入 `--execute` 才会写入。

```bash
mkdir -p ~/RestoreStaging

restore-cli restore \
  --repository /Volumes/Backup/RestoreBackup \
  --repository-id <repository-id> \
  --protection plaintext \
  --staging ~/RestoreStaging

# 从 restore 输出中复制实际的 Staging 路径：
STAGING_PATH='<staging-path>'

restore-cli --json apply \
  --repository /Volumes/Backup/RestoreBackup \
  --repository-id <repository-id> \
  --protection plaintext \
  --staging "$STAGING_PATH" \
  --target '<source-id>=<absolute-target-path>'

# 审核计划后再执行同一命令，并加入：
# --execute
```

从 dry-run JSON 中记录 `applyId` 并核对 `planFingerprint`；执行时复用 `--apply-id <apply-id>`。执行结果中的 `safetyId` 用于后续 `rollback`。

## 常用命令

```text
config                    配置目标、插件和备份周期
repository init|inspect   初始化或检查 v1 仓库
backup                    创建已验证恢复点
verify                    验证恢复点结构或受保护内容
restore                   恢复到隔离暂存目录
apply / rollback          预览或执行应用与回滚
recover                   生成新 Mac 恢复计划
migrate                   从 0.1.x 仓库复制迁移
daemon start|stop|status  管理定时备份
status                    查看备份状态
```

全局选项：

- `--json`：将最终结果以单个 JSON 对象写入 stdout。
- `--non-interactive`：禁止提示；缺少明确的安全参数时拒绝执行。
- `--verbose`：将调试信息写入 stderr。
- `--quiet`：隐藏非结果型信息。

完整操作步骤见[使用指南](https://github.com/ssbun/restore-cli/blob/main/docs/usage-guide.md)。新机器离线恢复另见[离线恢复检查清单](https://github.com/ssbun/restore-cli/blob/main/docs/recovery/offline-checklist.md)。

## 安全边界

- 默认配置创建明文仓库，依赖目标磁盘或共享本身提供访问保护。
- 应用安装默认只报告，不会隐式安装软件。
- Homebrew 和 VS Code 安装需要已审核计划、阶段确认与 `--execute-install`。
- App Store、DMG、Raycast 和无法识别的软件始终作为手工步骤报告。
- 调度器只执行备份，不执行恢复、迁移、安装或破坏性保留清理。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

许可证：MIT

# restore-cli 使用指南

本指南介绍 `@ssbun/restore-cli` 1.0 的日常备份、验证和恢复流程。示例中的 `<repository-id>`、`<point-id>`、`<source-id>` 和路径需要替换为你的实际值。

## 1. 准备环境

确认设备是 Apple Silicon Mac，系统为 macOS 14、15 或 26，并已安装 Node.js 20 或更高版本：

```bash
node --version
npm install -g @ssbun/restore-cli
restore-cli --version
```

主要备份与恢复命令支持 `--json` 输出机器可读结果。`config show/path/validate` 保持简短的人类可读输出。成功结果写入 stdout，诊断和错误写入 stderr。

## 2. 配置备份范围

运行交互式向导，选择 iCloud、本地目录或 SMB 目标，设置备份周期和需要启用的插件：

```bash
restore-cli config
```

向导会自动创建目标目录和明文 `RestoreBackup` 仓库，并将仓库 ID 写入配置。无需单独运行 `repository init` 或手工编辑 JSON5。明文仓库不加密内容，因此目标位置本身必须可信。为避免秘密信息被意外明文保存，包含 secret 来源的插件（例如 `ssh` 和 `sops`）不会出现在默认向导中。

查看和校验配置：

```bash
restore-cli config show
restore-cli config path
restore-cli config validate
```

`daemon.intervalHours` 设为 `0` 会禁用定时备份。配置文件使用 JSON5，可以包含注释。

## 3. 仓库管理

日常使用不需要手工初始化仓库；`restore-cli config` 已完成该步骤。`repository init` 保留给需要自行管理加密凭据等高级场景，不属于默认配置流程。

### 检查仓库

```bash
restore-cli repository inspect /Volumes/Backup/RestoreBackup \
  --repository-id <repository-id> \
  --protection plaintext
```

`inspect` 只检查身份和目标能力，不写入仓库。

## 4. 创建与检查备份

先用 dry-run 检查将要捕获的来源，不写仓库：

```bash
restore-cli backup --dry-run
```

确认后创建恢复点：

```bash
restore-cli backup
```

需要稳定 ID 时可指定 `--point-id <id>`。查看当前仓库、最近恢复点和调度状态：

```bash
restore-cli status
```

## 5. 验证恢复点

默认验证最新的健康恢复点及其结构：

```bash
restore-cli verify
```

常见选择方式：

```bash
restore-cli verify --latest --structural
restore-cli verify --latest-healthy --content
restore-cli verify --point <point-id> --content
restore-cli verify --all --structural
```

一次只能使用一个恢复点选择器；`--content` 与 `--structural` 也不能同时使用。长期备份应定期执行内容验证，而不只检查元数据。

## 6. 恢复配置文件

### 写入隔离暂存目录

暂存根目录必须已经存在：

```bash
mkdir -p ~/RestoreStaging

restore-cli restore \
  --repository /Volumes/Backup/RestoreBackup \
  --repository-id <repository-id> \
  --protection plaintext \
  --staging ~/RestoreStaging
```

命令输出中的 `Staging` 是本次恢复实际创建的目录，形式类似 `~/RestoreStaging/<point-id>-<fingerprint>`。复制该值供后续命令使用：

```bash
STAGING_PATH='<staging-path>'
```

默认选择最新的健康恢复点。也可以使用以下一种选择方式缩小范围：

```bash
--point <point-id>
--plugin <plugin-name>
--source <source-id>
--path '<source-id>=<relative-path>'
```

`--source` 和 `--path` 可以重复，但插件、来源和路径三类选择器不能混用。

### 预览并应用

`apply` 默认 dry-run。每个来源都要显式映射到绝对目标路径：

```bash
restore-cli --json apply \
  --repository /Volumes/Backup/RestoreBackup \
  --repository-id <repository-id> \
  --protection plaintext \
  --staging "$STAGING_PATH" \
  --target '<source-id>=<absolute-target-path>'
```

如果目标冲突，默认报错；可显式选择 `--overwrite` 或 `--skip`。从 dry-run JSON 中记录 `applyId` 和 `planFingerprint`。审核输出后，在同一条命令上加入 `--apply-id <apply-id> --execute` 执行。不要同时传 `--dry-run` 和 `--execute`。

执行时会创建持久 Safety Point。从执行结果 JSON 中记录 `safetyId`，回滚时需要它；若应用中断，则用之前记录的 `applyId` 继续绑定的操作。

### 回滚

先预览：

```bash
restore-cli --json rollback \
  --repository /Volumes/Backup/RestoreBackup \
  --repository-id <repository-id> \
  --protection plaintext \
  --staging "$STAGING_PATH" \
  --safety-id <safety-id>
```

确认后加入 `--execute`。只有确实要删除应用时新建的路径，才加入 `--delete-newly-created`。

## 7. 新 Mac 恢复计划

`recover` 会验证仓库并生成恢复与软件安装计划。默认只报告，不安装应用：

```bash
mkdir -p ~/RestoreStaging

restore-cli --json recover \
  --repository /Volumes/Backup/RestoreBackup \
  --repository-id <repository-id> \
  --protection plaintext \
  --staging-root ~/RestoreStaging
```

Homebrew 或 VS Code 安装是显式的两阶段操作。先保存共同参数，选择阶段并审核计划，再提供相同阶段的确认、计划 SHA-256 和 `--execute-install`：

```bash
REPOSITORY='/Volumes/Backup/RestoreBackup'
REPOSITORY_ID='<repository-id>'
STAGING_ROOT="$HOME/RestoreStaging"
STATE_DIRECTORY="$HOME/.config/restore/recovery-state"
install -d -m 700 "$STATE_DIRECTORY"

restore-cli --json recover \
  --repository "$REPOSITORY" \
  --repository-id "$REPOSITORY_ID" \
  --protection plaintext \
  --staging-root "$STAGING_ROOT" \
  --install-phase homebrew
```

审核 JSON 计划，并将其中的 `fingerprint` 字段保存为 `PLAN_FINGERPRINT`：

```bash
PLAN_FINGERPRINT='<fingerprint>'

restore-cli --json recover \
  --repository "$REPOSITORY" \
  --repository-id "$REPOSITORY_ID" \
  --protection plaintext \
  --staging-root "$STAGING_ROOT" \
  --install-phase homebrew \
  --confirm-phase homebrew \
  --approve-plan "$PLAN_FINGERPRINT" \
  --state-directory "$STATE_DIRECTORY" \
  --execute-install
```

App Store、DMG、Raycast 和未知应用只会列入手工步骤。完整的新机器流程见[离线恢复检查清单](recovery/offline-checklist.md)。

## 8. 定时备份

```bash
restore-cli daemon start
restore-cli daemon status
restore-cli daemon stop
```

周期来自配置中的 `daemon.intervalHours`；默认值为 12 小时，`0` 表示禁用。调度器只运行备份。

## 9. 迁移旧仓库

从 0.1.x 仓库迁移时，默认只生成复制计划：

```bash
restore-cli migrate --from /path/to/legacy/RestoreBackup
```

可重复传入 `--point <id>` 选择恢复点。审核后加入 `--execute` 执行只读来源、复制写入的迁移。

旧格式的兼容恢复命令为 `legacy-restore`；它与 v1 的 `restore` 不是同一个流程。

## 10. 自动化与排错

自动化时组合使用全局选项：

```bash
restore-cli --non-interactive --json verify --latest-healthy --content
```

- `--json`：支持该模式的操作命令在 stdout 输出一个最终 JSON 结果；`config show/path/validate` 除外。
- `--non-interactive`：禁止任何提示；参数不足或风险选择不明确时失败。
- `--quiet`：隐藏非结果信息。
- `--verbose`：将调试信息写入 stderr。

遇到失败时，先运行：

```bash
restore-cli config validate
restore-cli status
restore-cli daemon status
restore-cli repository inspect /path/to/RestoreBackup \
  --repository-id <repository-id> \
  --protection plaintext
```

不要通过删除仓库元数据、修改仓库 ID 或跳过恢复点验证来绕过错误；根据输出中的 issue code 和 `Next` 建议修复配置或重新连接正确的仓库。

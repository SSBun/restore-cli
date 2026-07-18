# 个人 CLI 工具 Wiki

这里记录我自己的 CLI 工具，方便以后查 Git 仓库、npm 包、安装方式和基础能力。

## restore-cli

### 地址

- Git：`git@github.com:SSBun/restore-cli.git`
- GitHub：https://github.com/ssbun/restore-cli
- npm：https://www.npmjs.com/package/@ssbun/restore-cli
- npm 包名：`@ssbun/restore-cli`
- 当前发布版本：`0.1.2`

### 安装

```bash
npm install -g @ssbun/restore-cli
```

### 基础命令

```bash
restore-cli config
restore-cli config show
restore-cli config path
restore-cli config validate
restore-cli backup
restore-cli backup --dry-run
restore-cli restore --list
restore-cli restore
restore-cli restore --dry-run
restore-cli restore --plugin <name>
restore-cli restore --to <dir>
restore-cli tool
restore-cli daemon start
restore-cli daemon stop
restore-cli daemon status
restore-cli status
```

### 基础功能

- 交互式配置备份目标、后台备份间隔、最大快照数和启用插件。
- 按插件收集重要配置文件和清单，生成快照备份。
- 未变化文件通过硬链接复用，减少重复占用。
- 支持 `backup --dry-run` 预览将要备份的内容。
- 支持列出快照、恢复快照、按插件恢复、恢复到指定目录和恢复 dry-run。
- 支持后台 daemon 定时备份，并可查看 daemon 状态。
- 支持 `status` 查看备份目录、快照数量、最近备份、大小和文件数。
- 支持运行内置插件工具，例如清单查看、刷新和恢复计划。
- 自动保留最近快照并清理旧快照，默认保留 14 个。

### 备注

- Node.js 要求：`>=20`
- 包入口命令：`restore-cli`
- 默认快照目录名：`RestoreBackup`

# 工作区上下文

## 已确认事实

- 仓库锁身份校验不再比较会被 iCloud 扩展属性更新改变的 `ctime`；仍比较 inode、设备、mode、size、nlink、mtime 和完整锁元数据，锁文件替换仍会被拒绝。
- `restore-cli backup` 的人类可读输出按插件分组来源、使用 ANSI 颜色与缩进；通用操作结果显示彩色状态、对齐元数据、计数和分级问题，`--json` 序列化保持不变。
- 配置向导把 v1 仓库固定初始化为 `<destination>/RestoreBackup`；同名目录（包括旧版仓库）已存在时会以 `REPOSITORY_PATH_OCCUPIED` 拒绝接管，但向导目前只显示统一初始化失败文案。
- `restore-cli config` 的默认流程会自动创建目标目录和明文 v1 `RestoreBackup` 仓库，并将仓库 ID 写入配置。
- 默认明文配置不提供包含 secret 来源的插件；已有加密仓库或已有独立授权的明文配置仍保留原有 secret 插件能力。
- v1 恢复先写入隔离 staging，再通过默认 dry-run 的 `apply` 显式应用。
- 项目使用 TypeScript、Commander、Clack、Vitest、Biome 和 pnpm。

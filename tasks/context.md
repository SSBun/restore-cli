## Project Core

### Purpose
- `@ssbun/restore-cli` 是面向 Apple Silicon Mac 的可读文件同步与恢复 CLI，将选中的配置和普通文件维护为一份最新严格镜像，并支持状态校验和确认式恢复。

### Global Vocabulary
- `RestoreBackup` 是最新可读镜像；manifest 记录来源、文件类型、权限、大小和 SHA-256；漂移（drift）是本地来源与镜像之间的新增、修改或删除差异。

### System Map
- `src/cli` 只提供 config、backup、status、restore 和 open；`src/config`、`src/plugin` 与 `src/catalog` 负责目标、插件和来源范围；`src/mirror` 负责扫描、哈希、镜像同步、校验、diff 与严格恢复。

### Global Invariants
- 运行环境限定为 Apple Silicon macOS 与 Node.js 20+；系统不保留历史、不加密且不调度；backup dry-run 不写目标，正式同步先在同步目录外构建并验证，再原位更新镜像；restore 必须先展示 create、modify、delete diff，并在交互确认或显式 `--execute` 后才能严格修改原路径。

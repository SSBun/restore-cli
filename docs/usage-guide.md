# restore-cli 使用指南

## 1. 配置

```bash
restore-cli config
restore-cli config show
restore-cli config validate
```

配置只包含同步目标和插件。镜像是可读明文，不支持 secret 来源。

## 2. 预览同步

```bash
restore-cli backup --dry-run
```

输出中的 `create`、`modify` 和 `delete` 表示更新严格镜像时将发生的变化。dry-run 不写目标。

## 3. 更新最新镜像

```bash
restore-cli backup
```

同步使用同目标目录中的临时树：先复制并校验全部当前来源，再整体替换旧镜像。旧镜像只会在新镜像验证成功后删除。

首次从旧恢复点仓库切换时需要显式替换：

```bash
restore-cli backup --dry-run --replace
restore-cli backup --replace
```

该操作删除全部旧恢复点历史，无法撤销。

## 4. 检查状态

```bash
restore-cli status
```

状态检查包含两部分：

1. 验证镜像结构、文件类型、权限、大小和 SHA-256。
2. 比较当前本地来源与镜像，显示本地漂移。

## 5. 恢复

只查看恢复差异：

```bash
restore-cli restore --dry-run
```

交互确认恢复：

```bash
restore-cli restore
```

自动化执行必须先单独保存并审核 dry-run 输出，然后显式运行：

```bash
restore-cli --non-interactive restore --execute
```

恢复采用严格匹配语义：

- 镜像有、本地没有：创建；
- 两边内容或类型不同：覆盖；
- 本地有、镜像没有：删除。

每个来源独立构建临时副本后再替换原路径；确认前不会修改原路径。

## 6. 打开同步存储

```bash
restore-cli open
```

Finder 会打开配置的同步存储目录；其中的 `RestoreBackup` 子目录是按插件和来源组织的可读镜像。

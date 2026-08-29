# Changelog

## [Unreleased]

## [2.0.0] - 2026-08-29

### Changed

- 将版本化恢复点仓库改为一份可直接浏览的最新严格镜像，文件按插件和来源组织。
- `backup` 先展示 create、modify、delete diff，再原位同步并用可读 manifest 和 SHA-256 校验结果。
- `status` 校验镜像并报告本地漂移；`restore` 展示完整 diff，确认后严格恢复原路径。
- `open` 改为打开配置的同步存储目录。

### Added

- 为长时间同步阶段增加 TTY 进度指示。
- 为来源清单和 diff 增加结构化终端表格。
- 为插件来源增加稳定文件排除列表，避免同步运行时临时文件。

### Removed

- 移除恢复点历史、UUID blob、加密封装、保留策略、调度器和 daemon。
- 移除 repository、verify、dump、apply、rollback、recover 与 tool 命令。
- 移除旧仓库格式兼容层；首次切换必须显式使用 `backup --replace`。

### Fixed

- 缺失的 optional 来源不再产生问题或降低同步状态。
- 镜像改为在同步目录外构建并校验，再在原目录内更新，避免 iCloud File Provider 生成冲突副本。

### Notes

- 这是不兼容版本。2.0.0 只保留最新副本，不提供历史回滚或加密。
- 严格镜像和严格恢复都会删除目标中来源已不存在的内容；操作前应先审核 dry-run diff。

[Unreleased]: https://github.com/SSBun/restore-cli/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/SSBun/restore-cli/releases/tag/v2.0.0

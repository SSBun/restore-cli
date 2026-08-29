# @ssbun/restore-cli

面向 Apple Silicon Mac 的可读文件同步与恢复 CLI。它把选中的配置文件和普通文件保存为一份最新严格镜像，不使用恢复点、UUID blob 或加密封装。

## 系统要求

- Apple Silicon Mac
- macOS 14、15 或 26
- Node.js 20+

## 安装

```bash
npm install -g @ssbun/restore-cli
restore-cli --version
```

## 配置

```bash
restore-cli config
```

向导只配置同步目标和需要同步的插件。镜像内容是可直接读取的明文；包含 secret 来源的插件不会开放选择。

## 同步

先查看严格镜像将发生的变化：

```bash
restore-cli backup --dry-run
```

确认后同步：

```bash
restore-cli backup
```

镜像按 `plugin/source` 组织，并保留原文件名和目录结构。隐藏 manifest 记录文件类型、权限、大小和 SHA-256。每次同步都会删除镜像中本地已不存在的内容，因此只保留最新副本，不提供历史回滚。

若目标中仍是旧恢复点仓库，先查看替换结果，再显式替换：

```bash
restore-cli backup --dry-run --replace
restore-cli backup --replace
```

## 状态

```bash
restore-cli status
```

`status` 验证镜像清单和文件哈希，并显示本地来源相对镜像的新增、修改和删除。

## 恢复

先只查看差异：

```bash
restore-cli restore --dry-run
```

交互运行会再次展示完整 diff，并询问是否恢复：

```bash
restore-cli restore
```

确认后，恢复会创建、覆盖和删除原路径内容，使其严格匹配镜像。非交互环境必须显式执行：

```bash
restore-cli --non-interactive restore --execute
```

## 命令

```text
config   配置目标和插件
backup   预览或更新最新严格镜像
status   验证镜像并显示本地漂移
restore  预览并确认恢复差异
open     在 Finder 中打开配置的同步存储目录
```

全局选项：

- `--json`：最终结果以单个 JSON 对象写入 stdout。
- `--non-interactive`：禁止提示，破坏性恢复必须显式使用 `--execute`。
- `--quiet`：隐藏非结果信息。
- `--verbose`：启用调试输出。

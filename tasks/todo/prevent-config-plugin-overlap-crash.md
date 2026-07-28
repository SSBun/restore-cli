# 阻止重叠插件导致配置向导崩溃

## 状态

Completed (2026-07-28 14:21)

## Target

- [x] T1：配置向导遇到来源范围重叠的插件组合时不抛出未捕获异常，并明确提示冲突。
- [x] T2：用户修正为兼容的插件组合后，配置可正常保存。
- [x] T3：`dotfiles` 不再作为内置插件出现，其他插件定义保持可用。

## Plan

1. 从内置注册表移除 `dotfiles` 并更新注册表断言。
2. 运行相关测试与项目质量门禁。

## Result

- T1：回归测试先复现向导只调用一次选择器并继续保存冲突组合；修复后，`buildCapturePlan` 的 `Sources overlap` 错误会显示为交互错误并重新打开插件选择，不再冒泡退出。
- T2：同一回归测试把选择从 `dotfiles + git` 修正为 `git` 后成功调用配置写入。
- T3：内置注册表与构建产物均不再包含 `dotfiles`，`csl-agent-kit` 及其他内置插件继续存在；注册表测试明确断言 `dotfiles` 缺失。
- 验证：`pnpm vitest run src/config/wizard-flow.test.ts tests/integration/plugin.test.ts` 通过（23 个测试）；`pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 通过；全量 `pnpm test` 通过（45 个文件、384 个测试）；构建产物插件清单探针通过。
- Review gate: Skipped — 用户未要求独立审查；改动限于移除一个内置注册项并有确定性注册表、构建产物和全量测试验证。

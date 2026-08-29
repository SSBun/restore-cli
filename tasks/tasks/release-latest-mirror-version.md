# 提交并发布最新镜像版本

Status: Completed (2026-08-29 08:36)
Kind: Task

## Scope

- 包含：版本 2.0.0、CHANGELOG、全部本地改动提交、`v2.0.0` Git tag、main/tag 推送以及公开 npm 包发布。
- 不包含：GitHub Release；仓库目前没有该发布渠道或既有 Release。

## Target
- [x] T1: 当前工作区全部本地改动以一个可追溯的发布提交进入版本库，提交后工作树干净
- [x] T2: 版本 2.0.0 在项目发布元数据中保持一致，并通过项目现有发布渠道成功发布且可查询

## Plan

1. 将 package source of truth 更新到 2.0.0，并新增破坏性变更、迁移和移除项的 CHANGELOG。
2. 运行允许的类型、lint、构建、入口与 npm 包内容预检；正式测试门禁另行获得明确授权。
3. 提交全部本地改动并展示 npm 用户、包内容、远端推送和正式发布命令。
4. 经正式发布确认后创建并推送 tag/main，发布 npm 2.0.0，查询 registry 验证。
5. 补记发布证据、完成任务并提交最后状态，使工作树干净。

## Result

- T1: 全部本地实现、文档、Context、任务记录和版本元数据已提交为 6783d7f（feat!: replace recovery points with latest readable mirror）并推送 origin/main；发布前工作树干净。
- T2: package.json source of truth、运行时与 CHANGELOG 均为 2.0.0；npm 正式发布成功，registry latest=2.0.0；v2.0.0 annotated tag 已推送并解析到 6783d7f。
- Review gate: Skipped — 用户未要求独立审查。

## Verification

- Passed: typecheck、Biome、build、45/45 tests、CLI 入口、npm pack dry-run、完整 npm publish dry-run、正式 prepublishOnly、npm registry 查询及远端 main/tag 查询全部通过。

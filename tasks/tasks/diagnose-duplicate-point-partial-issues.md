# 诊断重复 POINT_PARTIAL 状态问题

Status: Completed (2026-08-28 21:30)
Kind: Task

## Target
- [x] T1: 基于代码与可复现的状态输出，说明为何同一 POINT_PARTIAL 诊断被报告 34 次，并判断这是预期行为还是缺陷
- [x] T2: 重新运行 `restore-cli status`，并依据当前命令输出核实和报告状态降级原因

## Plan

1. 获取当前仓库的结构验证明细，并核对 34 的计数来源。
2. 追踪状态汇总如何把恢复点诊断转换为问题列表。
3. 核实 `/Users/caishilin/Desktop/personal/LinguaMark/dist` 是否参与失败，并给出结论。

## Result

- T1: 从 /Users/caishilin/Desktop/personal/LinguaMark/dist 运行 status 得到 65 个 partial 恢复点与 34 条问题（32×POINT_PARTIAL、1×RPO_DEGRADED、1×PLAINTEXT_REPOSITORY_INSECURE）；全量结构验证得到每点一条、共 65 条 POINT_PARTIAL，源码确认 status 截取前 32 条后追加两条仓库级问题。
- T2: 实际运行 restore-cli status 与 restore-cli --json status：当前为 65 个 partial、0 个 healthy、0 个 failed；34 条问题由 32×POINT_PARTIAL、1×RPO_DEGRADED、1×PLAINTEXT_REPOSITORY_INSECURE 构成，命令本身只给出继续结构验证的通用建议。
- Review gate: Skipped — 用户未要求独立审查。

## Verification

- Passed: 当前原始输出与 JSON 输出一致，status 退出码为 3，并确认其未直接暴露恢复点清单中的底层缺失源。

# ADR-039 — Artifact repair 无进展逃生门统一语义

- Status: accepted（四问拍板：BC1 批准 / BC2 批准 / BC3 方案 a / 免对抗审直接施工）
- Date: 2026-07-14
- Related: ADR-038 RuntimeContext 状态切片（本 ADR 是行为决策，非拆袋附属）、`artifactState.ts`、2026-06-25 phantom 死锁 dogfood、审计 HIGH-1

## Context

Artifact repair 的"无进展"计数存在三套语义分裂的账本，都通向 `ARTIFACT_REPAIR_MAX_ATTEMPTS`（=4）硬停但触发路径互不相通：

1. **attempts**（failureMap，真源）：校验失败次数。只有"写了但没过验收"会涨。
2. **repairTurnsWithoutProgress**：只在"请求不可见工具"路径累加，且被 messageProcessor 每回合无条件清零（审计 HIGH-1）——"本回合选了任一可用工具"就算进展，即使那些工具随后全被闸拦。
3. **blockedToolTurnsWithoutProgress**：为绕开前者的清零缺陷而另立的补丁计数器，只在执行层 block 路径累加。

此外两条 block 路径完全不设防：repeated-patch（同指纹补丁重放）与 edit-anchor-failure（Edit 锚定失败）只记工具名不计数，循环上界只剩外层 iteration 上限。还有一处自相矛盾：allowlist 把 Bash 列为 pre-patch 可见（2026-06-11 注释记载 block 会诱发死循环），enforcement 却无条件拦 `!patched`——可见但必拦，纯喂计数器空转。

2026-06-25 dogfood 死锁（CSDN URL 被错种成 phantom 修复目标，每个工具被 block 但计数不动）暴露的正是这种分裂：逃生门的覆盖面取决于失败走了哪条路径，而不是"有没有进展"这个语义本身。

## Decision

1. **"进展"统一定义为"目标文件被成功改动"**（`markTargetPatched` 口径）。读目标、选了可用工具、跑验证命令都不算进展。
2. **活性计数收敛为单一 `noProgressTurns`**（BC1）：原 2、3 两套计数器合并；unavailable-tool、repair 闸 block、repeated-patch、edit-anchor-failure 四条无进展路径共享累加；唯一清零点 = 目标成功改动。messageProcessor 的每回合无条件清零删除（HIGH-1 根治）。
3. **repeated-patch / edit-anchor-failure 接入计数**（BC2）：从无界变为连续 4 次无成功改动即 attempts-exhausted 硬停；硬停当次跳过恢复提示注入与重推理。中途任一次成功改动清零，正常"锚定失败→重试成功"不受影响。
4. **pre-patch Bash 对齐 allowlist 意图**（BC3 方案 a）：验证类命令（validator/test/typecheck/lint/build/compile 白名单正则）pre/post-patch 一律放行；source-read 类 Bash 维持拦截。
5. **attempts 保持独立语义不动**：它数的是补丁质量循环（校验失败），挂着 goal 2× 兜底降级（`getGoalArtifactRepairReleaseReason`）与 patience/重写策略，本轮零变化。
6. **状态收进切片**：failureMap 从 RuntimeContext expando 收进 `ArtifactState`（批 3e 漏网字段）；guard 重建的字段继承收编为 `rebuildRepairGuardOnValidationFailure`（消手抄逐字段继承）；`guard.phase` 收紧为字面量 union（行为分支只认 `'playability_repair'`，其余取值纯展示/遥测）。

两种硬停文案分流（unavailable-tool / attempts-exhausted）与 UI error 事件分流（`artifact_repair_admission_stop`）保持不变。

## Consequences

- 混合无进展场景（如 2 次 unavailable + 2 次 block）从"各自不到顶永不停"变为合计 4 次硬停——死锁保命优先；弱模型磨蹭场景会提前收口，但硬停只终止当轮，用户下一条消息即可重试，非死局。
- phantom 目标死锁的兜底逃生门现在覆盖全部四条无进展路径，不再取决于失败形态。
- 新增无进展路径时必须喂 `ctx.artifact.recordNoProgressTurn`；新增 guard 字段时只改 `rebuildRepairGuardOnValidationFailure`，调用方不再手抄继承。
- 行为级回归固化在 `tests/unit/agent/runtime/artifactRepairNoProgressEscape.test.ts`（phantom 死锁全链路 / 同指纹重放收口 / 连续锚定失败收口 + 硬停当次不再注入 / 成功改动清零续命）与 `artifactRepairAdmission.test.ts`（混合路径累积）。
- 工具结果 metadata 与推理遥测中的 `repairTurnsWithoutProgress` 字段更名为 `noProgressTurns`（无 renderer 消费方，旧会话持久化数据仅余一个无人读取的旧键）。

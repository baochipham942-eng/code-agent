# 对抗审计报告 — variant spine（T1 非破坏性版本底座）

**日期**: 2026-06-21
**范围**: `d389386..HEAD`（merge 后的 4 个 feature commit：spine 模型 + 适配 + canvas 接入 + proto 工作流 + 加固）
**起始 commit**: `d412b2c8d`
**审计模型**: Gemini（antigravity）独立 context 反方律师 + Claude skeptic 复核
**轮数**: 1（Codex 三次失败，详见下）
**收敛**: 部分（HIGH 全修；HIGH-3/MED-1/MED-2 经核验 defer/记录）

## 审计工具说明

Codex CLI 本轮三次尝试全部失败（gpt-5.5 报错 → gpt-5.4 报错 → gpt-5.4 内联源码 exit 124 超时），
属已知 codex exec 长任务/多文件读崩的 flakiness（见 `infra_codex_exec_cli_flakiness.md`）。
按跨模型评审降级标准（`infra_gemini_via_antigravity.md`），改用 Gemini(antigravity) 作独立反方，
Claude 作 skeptic 复核每条 finding。

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1 (Gemini) | 3 | 2 | 0 | `d412b2c8d`（修 HIGH-1/HIGH-2） |

## Findings

### 🔴 HIGH-1 — 深层血缘碎槽（groupKey = parentId ?? id）
**Finding**: 编辑「编辑版」时（A→A1→A2），A2.parentId=A1，groupKey(A2)=A1 与 groupKey(A1)=A 不同槽，
pin A2 不会取消 A/A1 的主版，打破「一槽一主版」不变量。
**复核**: 真。但仅 canvas「编辑编辑版」可触发；proto 全部 variant 共享合成锚点 parentId（扁平单槽），不受影响；
且原 canvas setChosen 早有同款 parentId 分组限制（非本次回归）。
**Resolution**: ✅ 修于 `d412b2c8d`。canvas `editRegion` 的 `parentId` 由 `baseNode.id` 改为 `groupKey(baseNode)`
（= parentId ?? id），编辑产物一律锚定血缘根，深链归并为单槽。spine groupKey 与 proto 模型不动。
测试：`designCanvasStore.test.ts` 深层血缘单主版用例。

### 🔴 HIGH-2 — 淘汰主版后 restore 双主版
**Finding**: `discardVariant`/`discardNode` 淘汰当前主版时只标 `discarded:true`、把同槽下一版升主版，
**但没清掉被淘汰者自身的 pinned/chosen**。之后 `restoreVariant` 恢复它 → 同槽两个活跃主版。
**复核**: 真，确凿。
**Resolution**: ✅ 修于 `d412b2c8d`。淘汰即 `pinned/chosen:false`（discarded ⇒ 必不 pinned）。
测试：`variantSpine.test.ts`「淘汰主版清自身 pinned」+ canvas 同款。

### 🔴 HIGH-3 — proto variant id 用绝对路径（搬迁/相对路径会复活已淘汰）
**Finding**: `makeProtoVariant` 把绝对路径写进 spine.json 作 id；若 run 目录被移动或 listVersions 返回相对路径，
`known.has` 失配 → 整盘磁盘文件被当新版重加，已淘汰复活、旧绝对路径幽灵霸占主版槽。
**复核 → ℹ️ Defer（记录）**: 前提是「移动 run 目录」。整个设计功能（history.runDir、selectedRunDir）都用稳定绝对
run 路径，run 目录按时间戳建、从不重命名/搬迁；一旦搬迁，设计历史本身就全断（不止 spine）。dogfood 实测
listVersions 路径与 spine id 一致、reconcile 去重正确。改相对路径需联动 reconcile/captureVersion/读盘解析，
牵动已 dogfood 验证的路径，收益仅覆盖一个不支持的操作 → 本期 defer，未来若支持 run 目录迁移再一并改。

### 🟡 MED-1 — reconcile 不处理手动删档（主版指向死文件）
**Finding**: `reconcileProtoSpine` 只补磁盘新增、不处理用户手删的版本文件；若 pinned 版 HTML 被删，spine 仍active+pinned 指向死文件。
**复核 → ℹ️ Defer（记录）**: 建议的「磁盘缺失即自动 discard」有竞态——listVersions 是 try/catch 失败返回 []，
一次瞬时 IO 失败会把整盘 spine 误标 discarded，且 discarded 不会随文件回归自动恢复，「治疗」比「病」更糟。
版本目录由 app 托管、用户正常不手删；VariantCompareView 对读不到的 htmlPath 已优雅降级（占位「…」）。本期 defer。

### 🟡 MED-2 — deserialize 严格类型守卫静默丢数据 + 忽略 version
**Finding**: `normalizeVariant` 用 `isFiniteNumber`，手改/轻微畸形（如 createdAt 变字符串 "100"）会整条静默丢弃；
`deserializeSpine` 不读 `raw.version`，未来迁移困难。
**复核 → ℹ️ 记录（不改）**: 该防御式丢弃刻意沿用既有 `deserializeCanvasDoc` 同款约定（全库一致），
改成 `Number()` 强转反而与既有规整模式分叉。version 当前恒为 1，迁移是未来事项。保持与 codebase 约定一致。

## Convergence Analysis

Gemini 一轮命中 2 个真 HIGH（HIGH-1 深链碎槽、HIGH-2 restore 双主版），均为「写一处护一处、对称/善后没补齐」类——
HIGH-2 正是 Round-N 高频的 symmetric application（升任新主版却没给旧主版善后）。两者已 TDD 修复并双模式对齐
（spine + canvas store 同步改）。HIGH-3/MED-1 是「依赖不支持操作」「竞态治疗更糟」型，独立核验后 defer；
MED-2 是「与既有约定一致」型，记录不改。proto 主链路（dogfood 实测）与浅层 canvas 不受任何 finding 影响。

**致谢**: Gemini caught 2 real HIGH bugs Claude's own pass under-weighted（尤其 HIGH-2 的 restore 双主版善后），
codex 缺席这轮由 Gemini 顶上，命中质量高。

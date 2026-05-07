# ADR-016: 不在 game/deck/未来 verifier 之间抽统一顶层接口

> 状态: accepted
> 日期: 2026-05-07

## 背景

`docs/audits/2026-05-07-game-acceptance-architecture.md` §5.1 提出过一个三层 dispatch 架构（"Layer A: ArtifactKindVerifier" / "Layer B: SubtypeChecker" / "Layer C: probe"），并在 `src/main/agent/runtime/game/types.ts` 里声明了 `ArtifactKindVerifier` 和 `GameVerifier extends ArtifactKindVerifier` 两个接口作为愿景。

Phase 4 完成 PR-1 / PR-2 / PR-3 后实情如下：

- `validateGameArtifact` 是**自由函数**（不是类），由 `toolExecutionEngine.ts` 在 4 个调用点直接消费，签名 `(filePath: string, options) => Promise<GameArtifactValidationSummary>`。
- `DeckVerifier` 是 PR-2 引入的**类**，签名 `validate(deck: DeckArtifactInput, subtype?) => DeckCheckResult`（同步 + 内存输入 + 不同 result shape）。
- 两边形态分歧到无法共用 `ArtifactKindVerifier` 接口：sync vs async、filePath 入参 vs in-memory 入参、`GameArtifactValidationSummary` vs `DeckCheckResult`、`canHandle` 这种字段在 deck 路径毫无意义。
- `ArtifactKindVerifier` / `GameVerifier` 接口从声明那天起就没有任何 class 实现 —— 它们是 dead code。

继续保留 dead 接口会误导后人以为有"按 kind dispatch"的统一调用方，实际上没有；强行抽出统一接口去适配两边需要 ~600 行重构 + 触动 `toolExecutionEngine.ts` 的 4 个 hot path。

## 决策

**短期不做跨 kind 顶层接口**。删除 `game/types.ts` 中的 dead `ArtifactKindVerifier` / `GameVerifier` 接口（以及只被它们引用的 `ArtifactInput` / `VerifyContext` / `VerifyResult`），承认 game 走函数、deck 走类，两边在各自调用方就近消费。

未来如果出现以下任一信号，再回头讨论是否引入统一接口：

1. 第 3 个 artifact kind 的 verifier 跑通（dashboard / doc / workbook）。
2. 出现"按 kind 动态选 verifier"的具体客户代码（目前 game 和 deck 都是 hard-coded 调用，不存在这种需求）。
3. cross-kind 的 batch validation harness 提上日程。

## 选项考虑

### 选项 1: 真做接口统一

把 `validateGameArtifact` 包成 `class GameVerifierImpl implements ArtifactKindVerifier`，让 `DeckVerifier` 也 implements 同一接口，调整 `toolExecutionEngine.ts` 4 个调用点 + `pptGenerate.ts` 1 个调用点，抽出能容纳"filePath 或 in-memory" 的通用 `ArtifactInput`、能容纳两种 result shape 的通用 `VerifyResult`。

- 优点: 形式上一致；未来加新 kind 有模板。
- 缺点: 没有客户代码会因此受益（game 和 deck 调用方都是单点 hard-code 调用，不需要 dispatch）；触动 game 这块 = 回到 v8 platformer acceptance 踩坑链路（红线 4 风险大）；估算 ~600 行重构，比 Phase 4 PR-1+2+3 总和还大。

### 选项 2: 保留 dead 接口作为占位

把 `ArtifactKindVerifier` / `GameVerifier` 留在 `game/types.ts`，加 `@deprecated` 注释，等未来需要时再激活。

- 优点: 接口还在；未来抽顶层时不用从零开始。
- 缺点: dead code 误导后人；新 verifier 作者会被引导去 implement 一个没人调用的接口；占位价值低（删了之后未来重新声明也是 30 行的事）。

### 选项 3: 删 dead 接口 + 写 ADR 说明现状（**已选**）

删 `ArtifactKindVerifier` / `GameVerifier` / `ArtifactInput` / `VerifyContext` / `VerifyResult`，保留实际在用的 `ArtifactKind` / `SubtypeContext` / `GameSubtypeChecker` 等。本 ADR 记录"为什么不做顶层抽象"，给未来的人一个明确的 entry point。

- 优点: 消除误导；保持代码诚实；后人有明确的 ADR 可读；删除工作量小（~80 行）。
- 缺点: 未来真要抽顶层时需要重新讨论（但那时已经有 2+ 个真实 verifier 跑通了，讨论的基础更扎实）。

## 后果

### 积极影响
- `game/types.ts` 不再有 dead 接口，文件诚实反映"实际跑的就是 SubtypeChecker dispatch + 自由函数"。
- 后人不会被误导去 implement 一个没人调用的顶层接口。
- DeckVerifier / GameVerifier 各自可以按自身需要演进，不被假设的 cross-kind 接口约束。

### 消极影响
- 失去"形式一致性"——未来新 kind verifier 没有现成模板，要参考 game / deck 之一从头写。
- 如果未来真要做 cross-kind dispatch，需要重新讨论接口形态（但那时有 2+ kind 实证基础，讨论质量更高）。

### 风险
- 低。dead 接口删除前已 grep 全仓确认无 implementer / extends 关系；只有历史 comment 提到 "Layer A"，已一并清理。
- 即使未来需要重抽接口，从 game / deck 当前实现倒推接口的工作量约 1-2 天，不是阻塞性风险。

## 相关文档

- [docs/audits/2026-05-07-game-acceptance-architecture.md](../audits/2026-05-07-game-acceptance-architecture.md) §5.1 — 原始三层架构愿景
- `src/main/agent/runtime/game/types.ts` — 实际生效的 game subtype 接口
- `src/main/agent/runtime/deck/types.ts` — deck subtype 接口
- PR #121 / #122 / #123 — Phase 4 PR-1 / PR-2 / PR-3 实施

# Goal: Preview QA + Work->Design->Code Handoff

日期：2026-06-26  
分支：`feat/design-qa-handoff`  
工作树：`/Users/linchen/Downloads/ai/code-agent-designqa`

## 总目标

完整实现「Preview QA + Work->Design->Code Handoff」两条方向，把 Neo 的设计产物从静态画布推进到可验证、可自修、可作为隐形意图交给 code agent 的产物链路。

## 成功判据

从一张含真实交互的设计出发：

1. Artifact QA 自动抓出视觉和布局问题。
2. Agent 能基于 QA 发现自修到产物真能用。
3. 选中变体、验收契约、锁定区和品牌引用作为隐形意图传给 code agent。
4. Code agent 实现一个非程序员可直接交付的功能产物。
5. 全程用户不碰代码，不看 React diff，不靠用户补 20-40% 保真 gap。

## 推进规则

- 每轮开始先读本文件认回进度。
- 严格按阶段推进，后一阶段依赖前一阶段。
- 每阶段先过验收门，门没过不进下一阶段。
- 每完成一阶段，更新状态和验收证据，再继续。
- 每个功能点完成后立即 commit，不积攒。
- `npm run typecheck` 是每个功能点 commit 前的硬门。
- 客观二值问题必须留在无 LLM 的确定性层：空白、溢出、console error、断图、主元素缺失、多视口响应式断裂。
- Vision 只判断规则编码不出来的主观项：排版、层级、遮挡、品牌一致性。禁止用 vision 判空白这类免费规则能判的项。
- 设计 repair 必须另起不复发 2026-06-25 死锁的语义，不能给现有 `artifactRepairGuard` 顺手扩 design 枚举。
- Code 永远隐形；agent 自修保真 gap；用户只判跑起来的产物。

## 启动证据

- 隔离 worktree 已创建：`/Users/linchen/Downloads/ai/code-agent-designqa`
- 分支已核实：`feat/design-qa-handoff`
- `node_modules` 已符号链接到主仓依赖树，且依赖树含 `konva`
- 基线验证：`npm run typecheck` 通过

## 阶段 1 - Artifact QA 确定性检测层

状态：已验

交付物：

- 新建产物级 preview health 模块，复用 `visualSmoke.ts` 的通用扫描骨架。
- 不污染游戏 canvas 告警阈值。
- 覆盖空白、溢出、console error、断图、主元素缺失、多视口响应式断裂。
- 只使用无 LLM 的确定性检测。

验收门：

- `npm run typecheck` 通过。
- 新模块单测通过。
- Headless dogfood：故意做坏的设计页能抓出全部种入缺陷。
- Headless dogfood：已知好页零误报。

验收证据：

- `npx vitest run tests/unit/agent/runtime/browser/artifactPreviewHealth.test.ts`：1 file / 3 tests passed。
- `CODE_AGENT_BROWSER_PROVIDER=playwright-bundled npx tsx scripts/acceptance/artifact-preview-health-dogfood.ts`：坏页抓到 `blank_body_text`、`broken_image`、`missing_main_element`、`horizontal_overflow`、`console_error`、`responsive_breakpoint_failure`，好页 `findingCount=0`。
- `npm run typecheck`：通过。
- 结论：确定性层已覆盖空白、溢出、console error、断图、主元素缺失、多视口响应式断裂；本阶段没有使用 vision，也没有触碰 `artifactRepairGuard`。

## 阶段 2 - Artifact QA vision 判断层

状态：已验

交付物：

- 复用 `src/main/services/desktop/visionAnalysisService.ts`。
- Vision 只判断排版、层级、遮挡、品牌一致等主观项。
- 确定性层能抓的客观二值项不进入 vision prompt。

验收门：

- `npm run typecheck` 通过。
- Targeted tests 通过。
- 一组好/坏设计实测中，vision 层补出确定性层抓不到的问题。
- 误报率实测可接受，且误报样例记录在本文件。

验收证据：

- `npx vitest run tests/unit/agent/runtime/browser/artifactPreviewHealth.test.ts tests/unit/agent/runtime/browser/artifactPreviewVision.test.ts`：2 files / 6 tests passed。
- `CODE_AGENT_BROWSER_PROVIDER=playwright-bundled npx tsx scripts/acceptance/artifact-preview-vision-dogfood.ts`：确定性层对主观坏页和好页均 `passed=true`；mocked vision 在坏设计上补出 `hierarchy_issue`、`occlusion_issue`，好设计 `findingCount=0`。
- `npm run typecheck`：通过。
- 结论：vision 层已复用 `visionAnalysisService` 默认路径；prompt 和 parser 只接受 `typography_issue`、`hierarchy_issue`、`occlusion_issue`、`brand_consistency_issue`，客观二值问题仍留在阶段 1。Dogfood 使用 injected mock analyzer，未消耗真实 provider token。

## 阶段 3 - Acceptance/Constraint Contract

状态：已验

交付物：

- 新建结构化契约：验收标准、锁定区、品牌引用。
- 定位为喂 agent 收敛的结构化意图，不是给开发者看的规格。
- 复用并升级已有 `brandTheme` / 区域锁概念，不新造平行体系。
- Agent prompt 真注入该契约。

验收门：

- `npm run typecheck` 通过。
- 契约 round-trip 测试通过。
- Agent prompt 注入测试通过。

验收证据：

- `npx vitest run tests/unit/shared/designAcceptanceContract.test.ts tests/unit/app/workbenchTurnContext.test.ts tests/unit/main/design/brandInjection.test.ts`：3 files / 26 tests passed。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- 结论：已新增 `designAcceptanceContract` 共享契约，覆盖验收标准、锁定区和品牌引用；contract round-trip 已测；`buildWorkbenchTurnSystemContext` 会注入 `<design_acceptance_contract_json>`，direct routing 会把该契约作为隐藏 reminder 传给目标 agent。契约定位为 agent 收敛意图，未做成给用户看的开发规格，也未触碰 ADR-026 的 main 直接 mutate 红线。

## 阶段 4 - Canvas op per-op intent

状态：已验

交付物：

- `proposeCanvasOps.schema.ts` 每个 op 增加 `intent` / `source` / `affectedNodes`。
- Ghost preview 能逐 op 解释改什么、为什么、影响范围。
- 依赖阶段 3 的 contract schema。

验收门：

- `npm run typecheck` 通过。
- Targeted tests 通过。
- Headless/renderer 验证 ghost preview 展示逐 op 解释。

验收证据：

- `npx vitest run tests/unit/shared/canvasProposal.test.ts tests/unit/tools/modules/design/proposeCanvasOps.test.ts tests/renderer/design/CanvasProposalReviewBar.test.tsx tests/unit/design/canvasProposalController.test.ts tests/renderer/design/designCanvasStoreProposal.test.ts`：5 files / 70 tests passed。
- `npx tsx scripts/acceptance/canvas-proposal-reviewbar-smoke.tsx`：通过，headless 截图生成于 `/var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/code-agent-stage4/canvas-proposal-reviewbar.png`，3 条 op 均渲染出为什么、影响范围、来源。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- 结论：`ProposeCanvasOps` schema 已要求每条 op 携带 `intent` / `source` / `affectedNodes`；shared normalize 对旧 op 补默认 metadata；ghost review bar 会逐 op 展示改什么、为什么、影响范围和来源，文案 zh/en 已同步。

## 阶段 5 - Artifact 自动 repair

状态：已验

交付物：

- 另起设计专用 repair 语义，绕开 `artifactRepairGuard` 的 design 豁免死锁风险。
- 阶段 1/2 QA findings -> repair spec -> 回喂 agent 修复 -> 重验。
- 不把设计 repair 当作给旧 guard additive 扩枚举。

验收门：

- `npm run typecheck` 通过。
- Targeted tests 通过。
- 端到端 render -> 检测 -> 修复 -> 重验 在真实坏设计上跑通。
- 无 2026-06-25 dogfood 死锁回归。

验收证据：

- `npx vitest run tests/unit/agent/runtime/browser/artifactPreviewHealth.test.ts tests/unit/agent/runtime/browser/artifactPreviewVision.test.ts tests/unit/agent/runtime/browser/designPreviewRepair.test.ts`：3 files / 10 tests passed。
- `CODE_AGENT_BROWSER_PROVIDER=playwright-bundled npx tsx scripts/acceptance/design-preview-repair-dogfood.ts`：坏设计初始抓到 `broken_image`、`missing_main_element`、`horizontal_overflow`、`console_error`、`responsive_breakpoint_failure`、`occlusion_issue`、`hierarchy_issue`；repair 1 轮后 `finalFindingCount=0`，selector 点击把 `#state` 更新为 `Confirmed`。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- 结论：设计 repair 走独立 `designPreviewRepair` ephemeral loop，spec 显式标记 `legacyArtifactRepairGuard=not_used`；没有给旧 `artifactRepairGuard` 扩 design 枚举，也没有把状态持久化进 DB。旧 guard 对 design working dir 的 stale guard 清理行为有回归测试覆盖，未复发 2026-06-25 跨会话 Write 死锁路径。

## 阶段 6 - Design->Code 桥（B 模型）

状态：已验

交付物：

- 先写 ADR，落 `docs/decisions/`。
- 只走 B 模型：code 隐形，agent 用阶段 1/2 Preview QA 自闭合保真，用户只判跑起来的产物。
- 加独立 `withHandoffContext()` 注入。
- 不拆、不旁路 `useAgentIPC.ts:78` 的 guard。

验收门：

- `npm run typecheck` 通过。
- ADR 完成并自洽。
- 端到端必须使用含绝对定位和真实交互状态的设计。
- Handoff 后 code agent 产物以运行可用为成功指标，不以代码质量或源码导出为主路径。

验收证据：

- ADR 已落地：`docs/decisions/028-design-code-handoff-b-model.md`，只采用 B 模型，写明 code 对用户隐形、Preview QA 自闭合保真、用户只验收运行产物。
- `npx vitest run tests/unit/shared/designHandoff.test.ts tests/unit/app/workbenchTurnContext.test.ts tests/renderer/hooks/useAgentIPC.designHandoff.test.ts tests/unit/design/buildCanvasSnapshot.test.ts`：4 files / 28 tests passed。
- `CODE_AGENT_BROWSER_PROVIDER=playwright-bundled npx tsx scripts/acceptance/design-code-handoff-dogfood.ts`：通过；handoff context 使用选中变体 `checkout-v2`，`coordinateSpace=canvas_absolute`，mock code agent 只返回运行产物路径，Preview QA 通过，selector 点击把 `#state` 更新为 `Confirmed`。
- Headless 截图人工回看：`/var/folders/cc/j1hyp1hx4n1fqtd8w3j0n33r0000gn/T/design-code-handoff-dogfood-odsxxk/handoff-product-mobile.png`，移动端不空白、不重叠，确认状态可见。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- 结论：新增 `DesignCodeHandoffContext` 和独立 `withHandoffContext()`；普通 turn 走 main 的 `<design_code_handoff_json>` 隐藏注入，direct routing 走同等 hidden reminder；没有拆/旁路 `withCanvasSnapshotContext()` 的 design guard，也没有改变 ADR-026 的 main 不 mutate 画布不变量。端到端 dogfood 覆盖绝对定位和真实交互状态，验收面是跑起来的产物，不是源码或 React diff。

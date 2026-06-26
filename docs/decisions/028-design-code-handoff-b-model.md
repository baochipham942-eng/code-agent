# ADR-028: Design to Code Handoff B Model

> 状态: accepted
> 日期: 2026-06-26

## 背景

Neo 的设计模式已经有三条基础能力：

1. ADR-026 定下 agent 只能提议画布操作，renderer 才能落地，main 永不直接 mutate 画布。
2. ADR-027 定下人挑变体是质量收敛信号，agent 在有界信封内发散。
3. Preview QA 已拆成确定性检测层和 vision 主观判断层，并能把发现回灌给设计 repair loop 自修。

Design to Code handoff 要解决的不是“把设计导出源码给开发者”，而是把用户已经挑中的设计产物、验收契约、锁定区、品牌引用和 QA 结论作为隐藏意图喂给 code agent。用户仍只判断最终跑起来的产物，不能被拉去看 React diff、改源码或补保真 gap。

## 决策

只采用 B 模型：

- Code 对用户隐形。主路径不展示源码、diff、组件树或导出包给用户判断。
- Code agent 接收隐藏 handoff context，包含选中变体、画布绝对布局、验收契约、锁定区、品牌引用和 Preview QA 证据。
- Code agent 用 Preview QA 自闭合 20-40% 保真 gap，失败时回到 repair loop，而不是把保真判断转嫁给用户。
- 用户验收标准是运行产物可用，尤其是真实交互状态能工作。

工程落点：

- 新增 `DesignCodeHandoffContext` 共享契约，定位为 agent 收敛用隐藏意图。
- renderer 新增独立 `withHandoffContext()`，从当前 design canvas 运行态提取选中/主版变体、绝对布局、画布快照和验收契约。
- `withHandoffContext()` 与现有 `withCanvasSnapshotContext()` 并列注入，不拆、不旁路 canvas snapshot 的 prompt bloat guard。那条 guard 只决定是否注入画布快照，不承担 handoff 隔离职责。
- main 的 turn system context 负责把 handoff JSON 注入隐藏上下文；direct routing 路径也 prepend 同等隐藏 reminder。
- 保持 ADR-026 不变量：handoff 只读 renderer 画布状态并生成上下文，main 和 agent 都不直接 mutate 画布。

## 选项考虑

### A 模型: 导出源码给开发者

- 优点: 对传统 IDE / Figma-to-code 流程熟悉，便于开发者接手。
- 缺点: 主路径会漂成 IDE；成功指标变成代码质量或源码可读性；非程序员用户被迫接触实现细节。

### B 模型: Code 隐形，agent 自闭合保真

- 优点: 符合 Neo 的 cowork 产品定位；用户只需要看跑起来的产物；Preview QA 可以成为自动保真闭环。
- 缺点: 对 QA 和 repair 质量要求更高；需要明确 handoff context，避免 code agent 丢失锁定区、品牌和交互状态。

### C 模型: 用户手动修保真 gap

- 优点: 系统实现最轻。
- 缺点: 把 20-40% 的最难保真工作推给用户，违背设计模式目标。

## 后果

### 积极影响

- Design mode 能自然走到可交付功能产物，而不是停在画布或源码。
- Preview QA 从设计修复延伸到 code handoff 后验收，形成同一套质量语言。
- 验收契约、锁定区和品牌引用成为 agent 可执行意图，减少自由发挥。

### 消极影响

- Handoff context 会增加 prompt 体量，需要限制字段和文本长度。
- E2E 验收必须覆盖绝对定位和真实交互状态，不能只测干净 landing page。
- Code agent 的修复循环要依赖 Preview QA 质量，检测误报会放大到 repair。

### 风险

- 若把 handoff context 渲染成用户可编辑开发规格，会把产品带回 IDE 路径。
- 若把 Preview QA 只当生成后报告，不回灌 repair，用户仍会承担保真 gap。
- 若绕开 `useAgentIPC` 现有 context pipeline，会造成 direct routing 与普通 turn 语义不一致。

## 相关文档

- [ADR-026: Agent 操作设计画布（人审批）](026-agent-operated-design-canvas.md)
- [ADR-027: 设计画布有界自主（预算信封 + 人挑收敛）](027-bounded-autonomy-design-canvas.md)
- [Goal: Preview QA + Work->Design->Code Handoff](../plans/goal-design-qa-handoff.md)

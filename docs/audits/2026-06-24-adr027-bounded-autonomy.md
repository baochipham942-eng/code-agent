# ADR-027 有界自主 · 对抗审计 + 付费 dogfood 收敛报告

- **日期**: 2026-06-24
- **分支**: `feat/design-autonomous-canvas`（基线 origin/main `af67c05d4`）
- **决策**: [ADR-027](../decisions/027-bounded-autonomy-design-canvas.md)
- **审计法**: 独立 context 反方 agent（skeptic），2 轮收敛，专攻付费安全不变量

## 范围

把设计画布从「每个出图提议都阻塞等人点头」升级为「人一次性批预算信封 → AI 信封内自主扇出 N 个发散变体 → 人挑一个」。审计重点：预算闸不被绕过 / 破坏性 op 不进自主 / abort 不漏付费 / est==actual。

## 对抗审计 2 轮

### Round 1（抓 2 HIGH + 2 MED + 2 LOW）
- **HIGH-1 · ¥天花板被自定义模型绕过**：自定义生图模型预算预估回落 ¥0.14、实际按真价（如 ¥3）扣 → 预算闸形同虚设、人看到假低预估。**修**：新增 `resolveAutonomyImageCostCny`，与 main `generateDesignImageViaCustom` 同源计价（`costCnyPerImage ?? estimateImageCostCny(modelName)`），预算闸 + 审批面板都用真实单价 → est==actual。
- **HIGH-2 · 孤儿信封**：abort 后信封未作废 → 下一轮无人复批即自动付费（红线⑥破）。**修**：信封绑 sessionId + 订阅 `SESSION_STATUS_UPDATE`，该 session 的 run 进终态（`isAutonomyRunTerminal`，含 idle/cancelled/interrupted…）即 clear；`CANVAS_PROPOSAL_CANCEL` 无条件清信封（修 applying 时 early-return 漏清的 case-a）。独立核实：`agentOrchestrator` 的 `finally` 无条件 `updateStatus(sessionId,'idle')`，abort/完成/异常都触发清信封。
- **MED-1 · 耗尽后免费 op 泄漏**：耗尽后免费 Layer1 op 仍在「已批准窗口外」自动应用。**修**：`autonomousApply` 毕 `isExhausted` 即 clear。

### Round 2（确认 R1 主路径都对 + 抓 2 新 MED + 1 新 LOW）
- **R1 三修主路径验证**：HIGH-1 est==actual 真闭合（同源计价 + 同一 resolve model）；HIGH-2(b) 靠 orchestrator finally→idle 状态绑定闭合；MED-1 干净。
- **MED-2（新）· resurrection 回流**：HIGH-2(a) 的「无条件 CANCEL clear」被 in-flight 出图用陈旧 env 引用 `setEnvelope` 写回 → 把已清的信封救活（手动 Stop 同此漏洞）。**修**：`makeBudgetedGenerate` 在 `await rawGenerate` 后**重读信封**，被清则不复活（付费已 commit 不退，但绝不拿陈旧引用救回信封）；顺带收敛 R1 LOW-2 同根问题。
- **MED-1（新）· fail-open**：`listCustomImageModels` 运行时失败回落 0.14 → HIGH-1 在 IPC 失败下重开。**修**：改快照法——grant 时把真实单价存信封（`perImageCny`），预算闸取 `max(价表估值, 快照)`，fail-closed 且去掉 per-ASK 拉取延迟。
- **LOW-1（新）· null 绑定误清**：null sessionId 信封被任意 session 终态误清。**修**：状态清要求 sessionId 非空且精确匹配。
- **R1 LOW-1/LOW-2**：复核确认低危（LOW-2 已随 MED-2 重读修法收敛）。

**收敛**：所有 HIGH/MED 已修，LOW 已修或确认可接受。144 自主测 + 437 design 测全绿，typecheck 净，build:web 通过。

## 付费 dogfood（真 key，一次性，林晨授权）

隔离端口 8188 起 webServer，真烧 wanx 出 3 张（模拟一轮 3 变体扇出，3 个发散方向），匹配紧凑 `"success":true` 防重复付费：

| 张 | actualModel | costCny | 落盘 |
|----|-------------|---------|------|
| 1 极简 | wanx2.1-t2i-turbo | 0.14 | 86KB PNG |
| 2 波普 | wanx2.1-t2i-turbo | 0.14 | 599KB PNG |
| 3 复古 | wanx2.1-t2i-turbo | 0.14 | 644KB PNG |

**真实成本喂进 ADR-027 预算账本**（信封 ¥0.5 / 3 变体）：3 张各 ¥0.14 → 剩余 2/¥0.36 → 1/¥0.22 → 0/¥0.08，耗尽，**第 4 张 `canAfford=false` 被预算闸硬停**（不超 ¥0.5）。

**结论**：真实 wanx 单价 0.14 == 审批面板/预算闸预估 0.14（**est==actual，HIGH-1 闸成立**）；3 张吃满信封后第 4 张被硬停（**不超花，红线①成立**）。总付费 ¥0.42，单次。
</content>

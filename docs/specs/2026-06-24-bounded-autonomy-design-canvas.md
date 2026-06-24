# 2026-06-24 设计画布有界自主（预算信封 + 人挑收敛）Spec

> **状态**：as-built，待 push/PR（分支 `feat/design-autonomous-canvas`）。
> **时间窗**：2026-06-23 → 06-24 CST
> **关联**：决策 [ADR-027](../decisions/027-bounded-autonomy-design-canvas.md)；建在 [ADR-026](../decisions/026-agent-operated-design-canvas.md) 之上；架构 [design-mode.md §5.16](../architecture/design-mode.md)；审计 [2026-06-24-adr027-bounded-autonomy.md](../audits/2026-06-24-adr027-bounded-autonomy.md)
> **定位铁律**：Agent Neo = cowork 人机协作产品（产物为主轴、对标 Manus），非编程 agent，用户默认非程序员。

把设计画布从 ADR-026 的「agent 每个出图提议都**阻塞等人逐张审批**」升级为「人**一次性批准预算信封**（目标 + ≤N 版 / ≤¥X）→ agent 在信封内**自主**连续出图、不再逐张问 → 信封耗尽后人从变体里**挑一个**」。核心立场不变——付费闸**没破**，只是从「逐张点头」上移到「信封预授权」；¥ 上限是硬天花板，绝不超花。

## 产品契约（Product Contract）

| 领域 | 契约 |
|------|------|
| 有界自主而非完全自主 | 人一次性批准「目标 + 预算信封 `{maxVariants, maxCny}`」（`RequestDesignAutonomy` 工具阻塞等审批，人可改）；agent 随后在信封内自主出图，无需逐张审批。 |
| 价值在多样性不在自我纠错 | agent 自主出 **N 个发散变体**（明显不同方向），**不自评质量、不自我修正**（绕开不靠谱 vision-critic）；它只因**信封耗尽**而停，绝不「自觉够好提前收手」。 |
| 人挑 = 唯一质量信号 | 系统不做机器质量判断；收敛靠**人挑**——挑中=主版（setChosen），其余变体自动软删进「已淘汰·恢复」托盘（可恢复）。被挑中的节点在画布快照里标 ★，回灌 agent 知道哪个方向赢了。 |
| 预算信封 = 付费预授权 | 信封双上限（变体数 ∧ ¥），任一先到即停。批准信封即预授权「最多 ¥X 的花费」；¥ 上限是硬天花板，付费前逐张过预算闸（est 不超剩余 ¥ 才出图），耗尽硬停。 |
| 成本诚实（est==actual） | 预算闸与审批面板的单价**与 main 实际出图同源计价**（内置模型查价表、自定义模型用 `costCnyPerImage`），杜绝「预估假低、实际真扣」绕过 ¥ 闸；grant 时把真实单价**快照进信封**，自主期不依赖运行时拉取（fail-closed）。 |
| 三层 op 分级 | 免费非破坏 Layer1（移动/连线/形状/改标签）自主内自动应用（不吃预算、可撤）；付费 `generateImage` 吃预算、信封内自动放行；**破坏性 op（淘汰/删除）永远逐步审批**，自主内被请求时 break out 回 ADR-026 人闸。 |
| 串行扇出 + 并排挑 | 执行串行（复用 ADR-026 二刀 Phase B 串行出图 + 单飞锁，零改付费链路）；扇出的 N 张落**同一变体组**（兄弟变体），人在对比视图并排挑。「并行」在人眼里不在执行里。 |
| 多轮 | 人挑后可「基于这张再来一轮」——picked 变体 + 一句话 steer 作下一轮种子，**需重新批信封**（每轮一道人闸）。受控多轮，非无监督续跑。 |
| 边界与降级 | 自主只在 brief 清晰后启动（模糊 brief 先走 T5 方向卡）；视频/编辑等高价 op 不进自主（只给文生图 t2i）；main 永不直接 mutate/付费；无交互画布（CLI/headless）→ `RequestDesignAutonomy` 明确回告「改用文字建议」。 |
| 生命周期（防孤儿信封） | 信封绑 agent run 的 sessionId；该 run 进终态（完成/中断/取消/空闲）即作废信封 + 变体组；abort/手动停亦作废；信封耗尽即作废。杜绝「run 结束后孤儿信封在下一轮无人复批即自动付费」。 |

## 范围（6 slice）

1. **信封预算账**（纯逻辑）：`{maxVariants,maxCny}` 双上限 + `canAfford`（付费前 est 闸）/`consume`（失败不吃版本槽、¥ 账诚实）/`isExhausted`/`remaining`。
2. **`RequestDesignAutonomy` 工具**（main 阻塞一次审批）：复刻 askUserQuestion 往返骨架 + 新 IPC `CANVAS_AUTONOMY_ASK/RESPONSE/CANCEL` + 超时 + 降级；回灌信封条款 + 强调人挑=质量信号。
3. **放行判断 + 预算闸 + 自动应用**（renderer）：`decideProposalHandling`（有信封∧非破坏→auto，否则 gate）+ `makeBudgetedGenerate`（付费前 est 闸、按成败消费、**await 后重读信封防 resurrection**）+ `autonomousApply`（复用 ADR-026 双相、回填剩余预算）+ 信封 store。
4. **变体分组 + 人挑回灌**：`makeGroupedGenerate`（首张建组、后续 parentId=组 id）+ 快照 `chosen` 标记 + `planUnpickedDiscards`（挑=主版+同组其余软删）。
5. **信封审批 UI + i18n + 生命周期**：`CanvasAutonomyReviewBar`（目标+可调生成数/预算+预估¥+Grant/Decline）+ 自主进度/停止指示 + zh/en + 绑 run 终态作废。

## 验证

- 144 自主单测 + 437 design 测全绿；typecheck 净；build:web 通过；1899 工具测 + capability/ipc/shared 门绿。
- **独立反方对抗审计 2 轮收敛**：R1 抓 2 HIGH（¥天花板被自定义模型绕过 / abort 孤儿信封）+2 MED+2 LOW 全修 → R2 确认 R1 主路径都对 + 抓 2 新 MED（resurrection 回流 / fail-open）+1 LOW 全修。
- **真 key 付费 dogfood✅**（¥0.42 单次）：真烧 wanx 3 张 t2i 全 costCny=0.14，真实成本喂进预算账本——3 张吃满信封 ¥0.5 后第 4 张被预算闸硬停（est==actual + 不超花）。

## 未覆盖 / 后续

- 自主期 agent 提议**编辑/扩图/去水印/视频**等衍生/高价付费 op 仍不开放（单独后续刀，每条破坏性/高价单独硬审批）。
- 近重复检测（感知哈希/embedding 去重）MVP 未做，多样性交给 agent prompt 工程 + 人挑兜底。
- 真机端到端（agent 真实驱动一轮 fan-out）建议在实际使用中观测；本刀付费验证用隔离 webServer 模拟扇出。
</content>

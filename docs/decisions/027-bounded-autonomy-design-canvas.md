# ADR-027: 设计画布有界自主（预算信封 + 人挑收敛）

- **状态**: 已采纳 — **D1-C + D2 三层 op 分级 + D3 串行自主(默认3/硬顶5) + D4 无 LLM critic + D5 挑=主版+多轮新信封 + 6 条红线全收**（2026-06-23 林晨拍板：「进这一刀，按推荐全要，做完整多轮」）
- **日期**: 2026-06-23
- **关联**: [ADR-026](026-agent-operated-design-canvas.md) 的自然下一刀（建在 proposal/approval/付费闸/variant spine 之上，**不否定**）；架构 [design-mode.md §5.15/§5.16](../architecture/design-mode.md)
- **定位铁律**: Agent Neo = cowork 人机协作产品（产物为主轴、对标 Manus），**不是编程 agent**，用户默认非程序员。设计画布是产物 surface 之一，人主导、AI 辅助。

## 背景

ADR-026 已落地「agent 提议 → 人**逐步**审批 → renderer 落地」，其中每个 `generateImage` 提议都**阻塞等人点头**（付费闸）。痛点：让 agent 试 3 个方向就是 3+ 次审批打断，每次都撞付费闸 —— **逐张点头的折磨**。

下一步探索「有界自主」：让 agent 自己看结果再发散、减少逐张点头。已拍板的判断（直接采纳，不重新论证）：

1. **不是「每步审批 vs 完全自主」二选一，而是有界自主**：用户一次性批准目标 + 预算信封（如「做个 hero 图，≤3 版 / ≤¥0.5」），agent 在信封内自主迭代，最后人审/挑成品。付费前置审批没破（预算预先批），省掉逐张点头。
2. **并行变体 + 人挑 > 串行自我批判**：agent 自评产物（vision-critic）不可靠，会过早收手或伪问题空转烧钱。改成「自主出 N 个发散变体 + 人挑一个」，绕开不靠谱 critic，又是设计师真实工作方式，天然复用 variant spine + 二刀成本闸。**自主的价值在多样性，不在自我纠错。**
3. **留人主导的边界**：破坏性 op（删/淘汰）永远每步；模糊 brief 的首轮方向人先掌舵（T5 方向卡）；视频等高单价 op 不自主重试。
4. 这是 ADR-026 的自然下一刀，不是否定。

### 三个 reframe（决定架构形状）

- **R1 — 「自主多轮编辑」的真身 = 预算信封 auto-clear 掉本会阻塞的付费提议。** 026 里每个 `generateImage` 提议都阻塞等人。有界自主只是把「逐张阻塞」换成「一次性批的预算信封，信封内出图提议自动放行 + check-and-consume 预算」，其它闸全留（破坏性→逐步、视频→逐步、信封耗尽→停）。新增面极小。
- **R2 — 「并行变体」的并行在人眼里，不在执行里。** 执行**串行**（复用二刀 Phase B「串行付费出图」+ 单飞并发锁，零改既有出图链路），agent 看每张结果驱动发散；人侧所有变体进 `VariantCompareView` **并排挑**。并行性在人的对比视图里。
- **R3 — 人挑 = critic。** 系统里唯一的质量信号是人挑。agent 永不自评质量、永不「自觉够好提前收手」（那正是不靠谱 critic 的病）——它**只因信封耗尽而停**。看结果**只为发散**（去重/补方向），绝不为「修这一张」或「提前停」。用可靠的人挑替换不可靠的机器自评作为收敛信号。

→ 贯穿硬线：**自主循环的停止条件永远是「信封耗尽」，不是「自评质量达标」。**

整个流程夹在两道人闸之间：
```
T5 方向卡(人掌舵模糊brief) → 批信封(一次付费预授权) → 【自主发散扇出】 → 人挑(=critic) → 主版 + 其余软删
                                                          ↑ 破坏性op/视频 在此 break out 回 026 逐步审批
```

## 决策

### D1 — 预算信封怎么定 = **C：双上限（版本数 ∧ ¥），先到先停；agent 提议、人一次性批/改**

信封 = `{ maxVariants: N, maxCny: ¥ }`，**任一上限先到即停**。agent 进入自主前用新工具 `RequestDesignAutonomy` 提议信封（它懂任务）；人**一次点头/微调**——这一批就是替代「逐张点头」的**付费预授权**。

- ¥ 上限是**神圣硬线**（钱的安全）；版本上限是 UX（别刷爆画布）。
- ¥ 预估仍由 renderer 查 `pricing.ts`（`estimateImageCostCny`）算，**不信 agent 报价**（沿用 026 红线）。
- 系统兜底默认信封（agent 没给值时）：版本默认 `DEFAULT_AUTONOMY_VARIANTS`，¥ 由价表派生（`DEFAULT_AUTONOMY_VARIANTS × 单张 t2i 估价 × 安全系数`），**不硬编码**（守禁硬编码铁律，落 `shared/constants`）。
- 否决 **A 只 ¥** / **B 只版本数**：单维都漏 —— 只卡 ¥ 可能刷 20 张便宜图糊画布，只卡版本数挡不住单张变贵。

### D2 — 哪些 op 吃预算 / 迭代上限 = **三层 op 分级，预算只管付费 op**

- **免费非破坏 Layer1**（move/connector/shape/rename）：自主 run 内**自动应用**（可 Cmd+Z 撤、进最终评审摘要），**不吃信封预算**。
- **付费 op**（`generateImage` 文生图）：**吃信封预算**，信封内自动放行 + check-and-consume，耗尽即停。
- **破坏性 op**（`discardNode` / 硬删永不开放）：**永远逐步审批**，在自主 run 内被请求时 **break out** 回 026 逐步人闸（守边界 3）。
- 系统**绝对天花板** `MAX_AUTONOMY_VARIANTS`（信封再大不可超，防失控；常量化）。
- **失败不吃版本槽**：出图失败/报错不计入版本上限（只有真落地的变体计数）；信封 ¥ 内允许有限 re-roll 失败张（受 ¥ 上限兜底）。

### D3 — 扇出形态 & 数量 = **串行自主（非真并行），N 由信封定、默认 3、硬顶 5**

- 执行**串行**：复用二刀 Phase B 串行出图 + 单飞 `applyingRequestId`，零改既有付费链路；agent 看每张结果驱动发散。
- 人侧**并排对比**：所有变体进 `VariantCompareView`（既有）。
- 「慢但正确」沿用二刀 MVP 立场（真并行付费要新并发 + 成本账 + 绕开单飞锁，不值）。
- 否决**真并行扇出**：agent 看不到中间结果 → 退回盲发散，丢掉多样性驱动。

### D4 — critic 用不用 = **不用 LLM 质量 critic；只留确定性闸（成败记账）**

- **无 LLM vision-critic**（绕开不靠谱）。
- 只保留**确定性闸**（非质量判断）：① 出图成功/失败记账（失败不吃版本槽）② ¥ 内有限 re-roll 失败张。
- 收敛信号 = **人挑**（R3），不是任何机器自评。
- 近重复检测（感知哈希/embedding 去重）**MVP 先不做**，多样性交给 agent 的 prompt 工程 + 人挑兜底，列为后续增强。
- 否决 **LLM 多样性 critic**：仍是 LLM 调用、仍有不可靠性，MVP 不值。

### D5 — 人挑回灌信号怎么喂回 = **挑=主版（setChosen）+ 其余软删；「再来一轮 like this」开新信封轮**

- 自主扇出的 N 张落成**同一 variant 组的兄弟变体**（共享 groupKey/parentId），进 `VariantCompareView` 并排。人挑 1 个 → `setChosen`（=主版），**其余变体自动软删进「已淘汰·恢复」托盘**（非破坏可恢复，三刀机制）。
  - 注意：此软删是**人挑这一下触发的系统动作**（人给「淘汰其余」做了那一步审批），不违反「破坏性 op 永远逐步」。
- **回灌 agent**：画布快照标记被挑中节点（`CanvasSnapshotNode.chosen`），下一轮注入时 agent 据此知道哪个方向赢了（即便人只点挑不打字）。
- **多轮 = 人可选「基于这张再来一轮」**：picked 变体 + 人的一句话 steer → 成为**下一轮信封的种子 brief**，**需重新批信封**（每轮一道闸，守付费预授权 + 人主导）。受控多轮，不是无监督续跑。
- 否决 **A 挑完即终**（丢迭代价值）/ **C 实时偏好学习**（太复杂）。

### 横切红线（写死，对抗审计重点盯）

1. **信封批准 = 付费预授权，上限即硬天花板**。¥ 耗尽工具硬停；中途人点「停」→ run 结束、保留已生成、不再花钱。付费闸没破，只从「逐张」移到「信封」。estimate（付费前查价）+ actual（付费后真扣）双账，**任何一张的 estimate 超出剩余 ¥ 即拒绝该张**。
2. **自主 MVP 只给文生图**（t2i ¥0.14）。`editRegion`/`expand`/`removeWatermark`/**视频** 等衍生/高价 op **不进自主**（视频太贵，守边界 3「高单价不自主重试」）——继续走 026 逐步审批。锁爆炸半径（沿用二刀哲学）。
3. **自主只在 brief 清晰后启动**。模糊 brief 先走 T5 方向卡人掌舵；自主夹在「方向卡」和「人挑」两道人闸之间。
4. **Main 永不直接 mutate / 永不直接付费**；信封态与预算账活在 renderer（成本权威所在），agent 只产提议 + 在信封授权下被 renderer 自动放行。
5. **降级**：无交互画布（CLI/headless）→ 自主不可用，`RequestDesignAutonomy` 明确回告「改用文字建议」（扩 026 降级）。
6. **stale / 并发**：自主 run 期间画布盖忙态遮罩（绑既有 `setGenerating`），人可 abort 不可并发手改；abort/超时保留已生成、信封作废、零后续付费。

## 架构形状（新增面收敛在五块，其余全复用）

| 块 | 落点 | 复用/新增 |
|----|------|-----------|
| 信封契约 + 预算账（纯逻辑） | `src/shared/contract/designAutonomy.ts`：`AutonomyEnvelope` 类型 + 纯 reducer（`grantEnvelope`/`canAfford(est)`/`consume(actual)`/`isExhausted`/`remaining`）| **新增**（纯函数，自包含可测）|
| 信封常量 | `src/shared/constants`：`DEFAULT_AUTONOMY_VARIANTS`/`MAX_AUTONOMY_VARIANTS`/`AUTONOMY_CNY_SAFETY_FACTOR` | **新增**（禁硬编码）|
| 批信封工具（main，阻塞一次） | `src/main/tools/modules/design/requestDesignAutonomy.ts`(+`.schema.ts`)：复刻 `proposeCanvasOps` 阻塞往返骨架，新 IPC `CANVAS_AUTONOMY_ASK/RESPONSE` + 超时 + 降级回告 | **新增**（骨架复用）|
| 信封态 + 放行判断（renderer） | `designAutonomyStore.ts`（active envelope + 剩余预算）；`decideProposalHandling(proposal, envelope)` 纯函数 → `auto` \| `gate`：有信封 ∧ 纯 generateImage ∧ 每张 est 不超剩余 → `auto`，否则 `gate`。在 `useCanvasProposalReview` 的 ASK 分流 | **新增判断 + 接既有 hook** |
| 自动放行落地 | 复用 `applyProposal`/`generateProposedImage`/`estimateImageCostCny`；auto 路径**不弹 UI**，消费预算，`respond` 回灌「applied + actual ¥ + 剩余信封」| **复用**，变体落入共享 group |
| 人挑 + 多轮 | 复用 `VariantCompareView` + `setChosen` + 软删托盘；快照加 `chosen` 标记；多轮种子 = 新信封 | **复用 + 快照加字段** |

**agent-driven 模型**：agent 在「信封授权窗口」内自己重复发 `proposeCanvasOps({generateImage})`，renderer 据信封自动放行 + 消费预算，预算闸硬停它；每张工具输出回灌「剩余 N 版 / ¥X」让 agent 决定是否继续发散。main 保持 dumb（照旧阻塞 + 等 respond），自主逻辑全在 renderer。

## 后果

### 正面
- 守住「人主导」：人批信封（付费预授权）+ 人挑（收敛信号）两道闸夹住自主；agent 只在信封内发散。
- 零新付费 / mutate 路径：复用 026 出图核 + 成本权威 + variant spine + 单飞锁；付费闸没破只是上移。
- 绕开不靠谱 critic：用人挑当 critic，确定性闸只做成败记账。

### 代价 / 风险
- **信封预算账是新不变量**：est/actual 双账、失败不扣版本槽、¥ 硬天花板——对抗审计重点盯「预算被绕过 / 超花 / 失败误扣」。
- **变体分组**：自主扇出落同一 variant group 需 `generateProposedImage` 支持「落入指定 group」而非各自 `nextNodePlacement`，是有界但真实的改动。
- **降级 / abort / 孤儿信封**：abort/超时须作废信封 + 撤 UI + 零后续付费（沿用 026 CANCEL 广播 + 单飞锁，扩到信封）。
- **慢**：串行出图 N 张耗时累加（MVP 取「慢但正确」）。

## 实施切分（逐刀 TDD，待逐点推进）

1. **信封契约 + 预算账**（纯逻辑 TDD）：类型 + reducer + 常量。
2. **`RequestDesignAutonomy` 工具**（main，阻塞一次审批）：复刻往返骨架 + 超时 + 降级。TDD 参数校验 / 超时 / 降级。
3. **放行判断 + 自动应用**（renderer）：`designAutonomyStore` + `decideProposalHandling` 纯函数 + 接 `useCanvasProposalReview` ASK 分流 → auto 不弹 UI、消费预算、回灌剩余。TDD 判断逻辑 + 预算消费 + 边界（信封耗尽/破坏性 break out/超 ¥ 拒单张）。
4. **变体分组 + 人挑回灌**：自主生成落共享 group；快照加 `chosen`；挑=setChosen + 其余软删。
5. **多轮种子 + UI + i18n**：信封审批面板 + 自主进度 + 人挑；zh/en 对齐。
6. **真机 E2E + 真 key 付费 dogfood**（默认只跑一次，付费前显式向林晨确认）+ **独立 context 对抗审计**修 HIGH/MED（重点：预算闸不被绕过、破坏性确 break out、abort 不漏付费、信封耗尽硬停、est/actual 双账一致）。

> 工作纪律同 026：origin/main 独立 worktree、TDD、对抗审计、CI 全绿不擅自合、更新 roadmap、付费 dogfood 默认只跑一次且付费前确认（[[feedback_paid_dogfood_cost_safety]]）。
</content>
</invoke>

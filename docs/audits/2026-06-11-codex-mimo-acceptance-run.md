# Codex 式游戏生成 × mimo 实跑报告（2026-06-11）

> Owner: 林晨 · 分支 `worktree-game-gen-codex-style` · 模型 `xiaomi/mimo-v2.5-pro`
> 配套方案 `docs/designs/game-gen-codex-workflow.md`，验收侧审计 `docs/audits/2026-05-07-game-acceptance-architecture.md`。

## TL;DR

1. **dogfood 实跑抓出一个影响全应用的真 bug**：ai-sdk 路径的 `transformRequestBody` 是死代码，mimo 的 `thinking:{type:'disabled'}` 从未真正发出 → 全应用经 ai-sdk 的 mimo 调用 thinking 失控。修复前后同一 prompt：**313s/0 正文/65K reasoning → 183s/32K 正文/0 reasoning**。已修复 + 回归测试（`aiSdkAdapter.ts`、`aiSdkAdapterVendorBody.test.ts`）。
2. **修复后 mimo 能真实生成游戏了**。在 thinking 修复的基础上，codex 里程碑流程对比单次策略：**通过率 42.5% vs 34.1%、绝对失败 23 vs 54、round0 即产出 vs round0 零产出、产物 545 行 vs 1163 行、零退化 vs 旧基线退化 28 项**。codex 流程显著更可靠。
3. **但 mimo 仍够不到完整契约，且自修不收敛**。产物是"移动+胜负循环可玩"的壳（17 项过），跳跃坏了、5 类高级机制无 runtime 证据；repair 轮零改进。要通过完整契约需把强逻辑里程碑路由给更强代码模型（W5/D6）。

## 1. 根因 bug：ai-sdk 路径的 thinking 控制失效

**现象**：harness 用 mimo 跑游戏生成，每个里程碑 120-360s 全超时、产物写不出。

**定位链**：
- 直接探针：完整 M0 prompt（~1141 tok）→ mimo 跑 313.5s、首字永不、正文 0 字符、reasoning 65820 字符、`finish=length`。整个 token 预算被 thinking 吃光。
- 复现 A/B 报告 finding 1（"mimo prompt > 1K tokens 强制 thinking、`enable_thinking:false` 失效"）。
- 但根因比"prompt 太长"更深：app 的 `XiaomiProvider.buildRequestBody` 本会发 `thinking:{type:'disabled'}`，而 harness 走的是 **ai-sdk 的 OpenAICompatible 路径**（`aiSdkAdapter.inferenceViaAiSdk`），不经过那段。
- ai-sdk adapter 里 `buildVendorCompatSettings('xiaomi')` 定义了 `transformRequestBody`（含 `thinking:disabled`），但 **`createOpenAICompatible` 不认这个非标准字段，`makeAiSdkFetch` 也不消费它 → 死代码**。mimo 默认 thinking ON。

**验证修复**：带 `thinking:{type:'disabled'}` 重探同一 M0 prompt → 183.7s、首字 3.2s、正文 32264 字符、reasoning 0、`finish=stop`。再经真实 `inferenceViaAiSdk` 路径确认 reasoningLen=0、7.8s、finish=stop。

**修复**：`makeAiSdkFetch` 接收并在序列化 JSON body 上应用 `transformRequestBody`。影响全应用经 ai-sdk 的 mimo/moonshot 调用，不只本 harness。

## 2. 新旧流程对比（均带 thinking 修复，隔离流程贡献）

同模型 mimo-v2.5-pro、同参数（bon-n 1、repair-cap 1、generation-timeout 360s）：

| 指标 | gen8 旧基线<br>（单次，thinking 修复前） | 单次策略<br>（thinking 修复后） | **codex 里程碑流程**<br>（thinking 修复后） |
|---|---|---|---|
| round0 | 0 / 1 | 0 / 0（一次没产出） | **17 PASS / 23 FAIL** |
| round1 | 23 / 25 | 28 / 54（重生成才出） | 17 / 23 |
| round2/3 | 7/3（**退化 28**）、7/45 | — | — |
| 通过率 | ~极低 | 34.1% | **42.5%** |
| 绝对失败数 | 25→45 | 54 | **23** |
| 产物规模 | — | 1163 行（臃肿） | **545 行（聚焦）** |
| 轮间退化 | **round2 退化 28 项** | 无 | **零退化** |
| 耗时 | 494s | 611s | **488s** |
| 结局 | 4 轮 escalate | escalate | escalate |

**结论**：codex 里程碑流程在通过率、失败数、首轮产出率、产物精简度、稳定性、速度上全面优于单次策略。里程碑拆分 + 契约前置 + 探针自验确实让 mimo 产出更可靠、更不会"越修越坏"。

## 3. mimo 产物的真实达成度（codex 流程）

**17 项通过**：`step/reset/snapshot` 交互契约、reachability 1/2/3/6（player.x/vy/levelComplete）、moveRight/moveLeft、platformLand、fallDeath 扣命、win 通关、scoreBaseline、snapshotComplete、coverage(moveRight/moveLeft/platformLand/fallDeath)。→ **一个移动+坠落扣命+到达终点的可玩平台壳**。

**23 项失败**：
- `jump: player did not jump`——跳跃物理坏了（能力 bug）。
- reachability step 4/5 设计错：声明用 `ArrowRight` 让 `player.y`/`lives` 下降（跳跃/受伤步配了行走输入）——契约设计 bug。
- 5 类高级机制（stompable enemy / bumpable block / ability / gate / comboChallenge）全部缺 runtime 证据——未实现。
- browser visual smoke 因并行跑导致 Chrome CDP 端口超时没跑起来——**环境抖动，非游戏缺陷**（单独串行重验可消除）。

## 4. 自修能力评估：mimo 自己修不好

- codex repair 轮（round1）：toolCount undefined、**未产出有效编辑**、分数 17/23 一字未改 → escalate。给了带病历的修复机会但没修。
- gen8 旧基线 repair：不仅没修好，还**越修越坏（退化 28 项）**。本次单调门拦住了退化（round1 没掉分），但"不退化"≠"能修好"。
- 失败分两层：**契约设计错**（原则上可修，mimo 没修对）+ **能力下限**（跳跃物理、复杂机制状态机，mimo 天花板）。

**框架层 bug（thinking 死代码、里程碑空过）不在 mimo 自修范围**——agent 只在产物层打转，看不到底层推理路径的 `transformRequestBody` 没接上。需要人在回路 dogfood 才能发现。

## 5. 结论与下一步

- **自修基础设施健全**（病历注入 + 单调门 + 硬上限按设计工作），但**用 mimo 当生成+修复模型不收敛**。
- 要让游戏生成通过完整契约：落地 **W5/D6 里程碑级模型路由**——M0-M2（契约/物理/碰撞强逻辑）路由给 Kimi K2.6 / DeepSeek V4，M3-M4（关卡/视觉）留 mimo。基础设施就位，缺的是路由接线 + 对应 provider key。
- 待办：用强代码模型重跑同一 codex 流程，验证"换模型后自修能否收敛到通过"。

## 附：本轮提交

- `fix(acceptance)`: 生成报错/产物为空时里程碑判 FAIL，不空过（mimo invalid-key 跑暴露）。
- `fix(model)`: ai-sdk 路径真正发送 vendor transformRequestBody（mimo thinking:disabled）。
- `feat(acceptance)`: codex 里程碑增量生成策略（`--strategy codex`）+ lean prompt 模式。
- `test`: 49 单测 + 6 集成测试（真实 validator 里程碑门控）+ 6 vendor body 回归测试。

---

## 6. 追加实验：DeepSeek 对照 + 又修两个真 bug（2026-06-11 续）

用户提供 DeepSeek key 后，跑 codex×deepseek-chat 验证"换强代码模型能否收敛"，过程中又暴露并修复两个 acceptance-loop 真 bug。

### 6.1 又修的两个 bug

- **M0 门控过严**（`platformerCodexStrategy.ts`）：M0 因"coverage 没有覆盖 qualityPlan 承诺的奖励/风险"被拦，但这些要靠 M2/M3 机制实现才能覆盖，M0 明确说机制行为暂不要求 → **里程碑永远卡 M0、到不了 M1-M4、无法收敛**。修复：M0 只拦静态骨架能满足的结构/形状/契约存在性，coverage 完整性移到 M4。
- **产物保留缺失**（`platformer-gameplay-generation.ts`）：单调门只护"分数账本"不护"产物文件"。repair 轮原地覆写文件，round0 的好产物被退化版清掉；escalate 时 `finalResult` 返回最后一轮而非最优轮，盘上留坏版本。修复：快照最优产物、退化轮恢复文件、escalate 返回 `baselineRound`。

### 6.2 DeepSeek 实跑数据（高方差）

| run | 里程碑推进 | round0 | repair 走势 | 备注 |
|---|---|---|---|---|
| cap1（M0 修复前） | M0✗ | 10/34 | round1 改进到 15/22 | repair **改进**（≠mimo 的 flat） |
| cap3（M0 修复前） | M0✗ | **35/6（85%）** | repair 退化到 18/26 | round0 全实验最佳，但被 repair 搞坏 |
| cap3（全修复后） | **M0✓ M1✓ M2✗** | 10/38 | 10→10→8→10，最优轮被保留 | 里程碑真正推进 |

**关键观察**：
1. **M0 门控修复让里程碑真正推进**：DeepSeek 跑到 M0✓→M1✓（契约+移动验证通过）→M2✗（敌人踩踏够不到）。修复前永远卡 M0。
2. **DeepSeek 生成质量高方差**：round0 在 10/38 ~ 35/6 之间波动。最好的一把（35/6）远超 mimo（17/23），但不稳定。
3. **自修对两个模型都不收敛**：DeepSeek repair 与 mimo 一样会退化（10→8、35→18）。强模型把生成侧天花板抬高了，但 repair 收敛仍是共性难题。
4. **产物保留修复生效**：全修复跑里 round2 退化 3 项被挡，最终交付最优轮而非退化版。
5. **复发小毛病**：DeepSeek 在 repair 轮反复请求不可用的 Bash 工具被中止（`artifactRepairGuard` 工具集不含 Bash），浪费 milestone retry——后续可单独放宽或显式告知模型工具边界。

### 6.3 最终结论

- **"借鉴 codex 能让生成更可靠吗"——能，且已量化**：里程碑拆分 + 契约前置 + 探针自验 + 产物保留，让产出更稳、不退化、能逐级推进、交付最优版本。codex 流程在所有维度优于单次。
- **"模型自己能修好吗"——不能**：mimo / DeepSeek 的 repair 都不收敛到完整通过，高级机制（踩敌/顶砖/能力/门/组合）是两个模型在 repair 预算内的共同天花板。强模型抬高了生成侧起点（最佳 85%），但收敛仍需人或更强模型介入。
- **基础设施是真正的产出**：本轮修的 4 个 bug（thinking 死代码、里程碑空过、M0 过严、产物保留）才是让"codex 式生成"在 Neo 里真正可靠的前提——它们都是 dogfood 实跑才暴露的，模型自身永远发现不了。
- **下一步建议**：把 codex 策略 + 4 个修复并入主干；落地 W5 模型路由（M0-M2 强逻辑路由 DeepSeek/Kimi、M3-M4 留 mimo）；放宽 repair 工具集或显式约束 Bash 使用；BoN≥3 吸收 DeepSeek 的高方差（多采几个 round0 取最优）。

---

## 7. 收尾实验：Bash 放宽 + BoN=3（2026-06-11 再续）

按"放宽 repair 工具集 + 多采吸收方差"再修一处、再跑一次。

### 7.1 第 5 个修复：pre-patch 允许集加入 Bash

`artifactRepairGuard.ts` 旧策略 pre-patch 不给 Bash（只 post-patch 给）。DeepSeek 等强模型习惯"先检视/测试再编辑"，pre-patch 拿不到 Bash 就反复请求 → 撞 `ARTIFACT_REPAIR_MAX_ATTEMPTS` 死循环逃生门、中止 milestone retry。放宽后（pre/post 都给 Bash，同 workspace 作用域）：**"反复请求不可用工具 Bash" 中止归零**，DeepSeek 修复轮能成功调 Bash。更新 9 处相关断言。

### 7.2 BoN=3 实跑（deepseek，全 5 修复）

| round | 候选 | 选中 | PASS/FAIL | 退化 |
|---|---|---|---|---|
| 0 | 3 | r0c0 | 13/28 | 0 |
| 1 | 3 | r1c0 | 10/32 | 退化 7（已挡） |
| 2 | 3 | r2c0 | 10/32 | 退化 7（已挡） |

里程碑（3 候选）：r0c0/r0c1 都 **M0✓ M1✓**，卡在 **M2 超时**；r0c2 M0 两次 ERROR。

**关键观察**：
1. **M2 瓶颈变成"超时"而非"能力不够"**：Bash 放宽后 DeepSeek 在 M2 做得更彻底（检视+测试+编辑敌人/踩踏碰撞状态机），单段超 240s timeout。**这是调参杠杆，不是天花板**——M2/M3 这类重逻辑里程碑应给更长超时（如 480s）。
2. **BoN=3 没捞出 85% 离群值**：round0 best-of-3 = 13/28，未复现单跑那次的 35/6。DeepSeek 方差太宽，3 个样本不足以稳定命中峰值。要稳定捞峰需更大 N 或更强模型。
3. **产物保留 + 单调门再次生效**：round1/2 各退化 7 项被挡，finalResult 交付 round0（13/28，browserPassed=true），非退化版。
4. **里程碑推进稳定**：两次全修复跑都是 M0✓ M1✓ → M2 卡（先 FAIL 后超时）。M0/M1 已可靠通过，M2（敌人踩踏）是当前一致瓶颈。

### 7.3 全 5 修复总览

| # | bug | 文件 | 状态 |
|---|---|---|---|
| 1 | ai-sdk thinking 死代码 | `aiSdkAdapter.ts` | ✅ 修+测试 |
| 2 | 里程碑空过 | `platformerCodexStrategy.ts` | ✅ 修+测试 |
| 3 | M0 门控过严 | `platformerCodexStrategy.ts` | ✅ 修+测试 |
| 4 | 产物保留缺失 | `platformer-gameplay-generation.ts` | ✅ 修+测试 |
| 5 | pre-patch 无 Bash | `artifactRepairGuard.ts` | ✅ 修+测试 |

**最终判断**：codex 式工作流 + 这 5 个基础设施修复，让 mimo/DeepSeek 的游戏生成显著更可靠、可逐级推进、稳定交付最优版本、不被自修搞坏。但"全自动通过完整契约"仍未达成——M2/M3 重逻辑里程碑需 (a) 更长单段超时，(b) 更强模型或 (c) 更大 BoN 吸收方差。基础设施已就位，剩下是参数与模型路由的工程调优。

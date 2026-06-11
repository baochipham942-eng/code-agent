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

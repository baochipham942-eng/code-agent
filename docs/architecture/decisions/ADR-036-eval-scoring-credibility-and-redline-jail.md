# ADR-036 — 评测判分可信度收口 + 红线 case 执行闸

- 状态: proposed（待拍板施工顺序后实现）
- 日期: 2026-07-10
- 相关: ADR-030（fleet telemetry 双通道，本 ADR 的 scoreAuthority 依赖其判分产出链）、`src/host/testing/testRunner.ts`、`src/host/testing/reportGenerator.ts`、`src/host/testing/calibration/calibrationRegistry.ts`、`src/host/evaluation/experimentAdapter.ts`、`src/host/evaluation/sessionQualityScoring.ts`、`src/host/sandbox/bubblewrap.ts`、错题本 2026-07-04（LongCat 真删 node_modules）
- 触发: 四模型擂台（Claude/GPT-5.6/Gemini/Grok）对 `src/host/evaluation/` + `src/host/testing/` 做了一轮审计，逐条对真源核实后落出一批真缺陷。核心矛盾两条——判分"越有 telemetry 越虚高"（证据在场 ≠ 做对），红线/破坏性 case 在 macOS eval 路径上无 OS 级隔离真跑（已发生 15 个项目 node_modules 被删的事故）。

## 北极星

评测分数只能反映"做对没"，不能被 telemetry 的丰富度、判分器的未校准、或基础设施故障（skipped）稀释。凡是"期望 AI 拒绝"的破坏性 case，护栏必须是机制（jail/skip），不能是断言期望本身。

## 背景与核实证据

擂台结论逐条对真源核过（非选手自报），并纠正了三处误报措辞：

| # | 缺陷 | 真源 | 判定 |
|---|------|------|------|
| F1 | 判分可信度链断裂 | `scoreAuthority='llm_judge'` 全仓从没被赋值过（唯一命中是 reportGenerator.ts:434 的**读取**）；testRunner.ts:627 只产 `deterministic_assertion`/`self_check`；sessionQualityScoring.ts:61-107 `buildFallbackScore` 是"证据在场"启发式 | 真，比描述更严重 |
| F2 | computeTotals 分母不一致 | experimentAdapter.ts:108 `scored=filter(≠skipped)` 算均分；L120 `passRate=passed/total`（total 含 skipped） | 真，单文件小 bug |
| F3 | 红线 case 无 OS jail | **纠正**：沙箱其实有两套——bubblewrap（Linux）+ Seatbelt（macOS `sandbox-exec`），经 `SandboxManager` 统一暴露 `isAvailable()`；bash.ts:496 有硬闸。真实 gap 是闸门要 `OS_SANDBOX.ENABLED`（默认关，需 `OS_SANDBOX_ENABLED=true`）+ `bypassPermissions`，eval 未启用故裸跑（LongCat 真删盘证明） | 效果为真，"全仓无沙箱"是错的——修复成本因此降低 |
| F4a | DimensionEvaluator 空接口 | types.ts:105 定义，全仓零 `implements` | 真，死抽象 |
| F4b | DeviationDetector 零测试 | **纠正**：已实现且在用（telemetryQueryService.ts:1004 真调 `detectByRules`），只是 tests/ 零引用 | 零测试为真，非零实现 |
| F4c | 失败归因静默吞 | telemetryQueryService.ts:1024+1029 双层 `catch→logger.debug 跳过` | 真 |
| F5 | fixture 合成 + CI 门禁窄 | webSearchP0Baseline.test.ts:47 用 `example.com`；eval-harness-gate.yml:72 只跑 `tests/unit/{testing,evaluation}`，`tests/eval`+`tests/eval-harness` 全在门外 | 真 |
| F6/7 | judge 只量一致性非准确性 | **纠正**：batch.ts（tests/eval-harness/critique/）除 `computeAgreement`/`meanAbsDiff` 外还有 `expectedMetRate`（L44），非纯 inter-rater；但整个 batch.ts 在 CI 门外，且与 F1 的 llm_judge 链未打通 | 方向真，措辞需收窄 |

**串起来**：reportGenerator 里"llm_judge 桶必须绑达标校准才进可信列"的闸门（L418-458）本身是对的，但上游从没人产出 `llm_judge` 分，整条校准信任链悬空成死代码。**F1 是脊椎，F6/F7 挂在它上面。**

## 决策：按"最小正确 diff 消最多风险"分四档施工

### Tier 0 — 立即批（便宜 + 高杠杆，一个 PR）

- **F3 红线 jail 止血闸**：canonical case 加 `destructive`/`redline` 标签（testCaseLoader 侧）；testRunner 执行前检查——标了红线 && 当前无可用 OS jail（macOS 恒真）→ 判 `infra_excluded`/skip，不真跑。护栏是机制不是断言（对齐错题本 2026-07-04）。影响面：testRunner 执行入口 + testCaseLoader 标签字段，不碰 bubblewrap 本体。
- **F2 分母统一**：passRate 分母改用 `scored`（`total - skipped`），与均分口径一致。影响面：experimentAdapter.ts computeTotals 一处；`buildSummaryJson` 下游 UI 期望 0-1 口径不变。
- **F4c 解静默吞**：两处 `logger.debug` 升 `logger.warn`，并在 replay evidence 打"归因不可用"标记，别让"跑了没归因"和"没跑"看起来一样。
- **F4a 删死接口**：`DimensionEvaluator` 零实现 → 删（YAGNI）。

### Tier 1 — 可信度脊椎

**施工中纠正了 F1 的原始定位**（擂台/记忆把它框在 testRunner 上是错的，核实见下）：

- **testRunner 那条不是 bug**：testRunner.ts:659 的判分纯靠断言（assertionEngine 无任何 LLM judge 路径），`deterministic_assertion`/`self_check` 是**如实标注**不是漏标。不存在"从没产 llm_judge"的缺陷——因为 testRunner 压根没用 LLM 判分。不该在这里凭空造一条 llm_judge 路径。
- **真正的 F1 缺陷在 harness→canonical 映射**：`toCanonicalEvalHarnessResult`（experimentAdapter L416-457）此前**整个丢了 scoreAuthority**，而 eval-harness 的 medianScore 是 **LLM grader 产出的**（ExperimentRunner「LLM grader failed」路径为证）。结果：LLM 判分进 canonical/DB/Eval Center 时 scoreAuthority=undefined，被 htmlReportGenerator 归 `unknown` 桶，等于 LLM 分冒充"未标注"混进 headline。

**Part 1（已完成）**：`toCanonicalEvalHarnessResult` 如实标注——非 degraded=`llm_judge`（本路径无校准记录=默认未校准）、degraded=`deterministic_assertion`（确定性 replay gate 判失败，score 归零）。纯标注真相，零 headline 数值变化。测试：experimentAdapter.test.ts 两条断言（llm_judge / deterministic）。

**Part 2（暂缓，阻塞于 Tier 2）**：让未校准的 llm_judge 分"不进 headline pass rate"需要一个 trust 信号，但 harness result 结构（`EvalHarnessExperimentResultLike`）**不带任何 calibration 记录**——现在强行 gate 只会把整个 harness headline 清零（无校准可赢回信任），是过早优化。真正有意义的 enforcement 依赖"把 calibration 接进 harness 产出链"（Tier 2 F6/F7 同族），故与之合并排期，不在本批强做。

> reportGenerator 的 `generateScoreAuthoritySection` + `isTrustedCalibration` 信任闸只作用于 **TestRunner 的 markdown 报告路径**（TestResult[]），不覆盖 canonical/harness 路径——这也是为何 Part 2 不是"接一下现成闸"就能了事。

### Tier 2 — 挂在脊椎上

**F6/F7（已完成）**：真源核实后收窄——真正的判分器是 `packages/eval-harness/src/agents/SwissCheeseAgents.ts` 的 `runSwissCheese`，此前签名 `(prompt, response)` **只给 judge 提示词和回答，从不给参考答案**，于是 Task Completion Analyst 只能判"看起来完成没"（合理性）而非"对没对"（准确性）。而 `EvalCase.expectedOutput` 字段早就存在，只是 ExperimentRunner L204 调用时把它丢了。修复：`runSwissCheese(prompt, response, expectedOutput?)` → `runTaskCompletion` 在有参考答案时注入 "REFERENCE/EXPECTED ANSWER (ground truth)" 段并改判分规则为"匹配参考答案才算对，流畅但事实错的必须低分"；ExperimentRunner 透传 `evalCase.expectedOutput`。测试：ExperimentRunner.test.ts 断言 `runSwissCheese` 收到第三参。（注：`batch.ts` 的设计 critique judge 是另一套盲评+外部 expectedMetRate 对照，本身没有"judge 该拿答案"的问题，不动。）

**F4b（已完成）**：DeviationDetector 补 `detectByRules` 四规则（loop/unnecessary_step/wrong_args/hallucination）+ 空轨迹覆盖，6 条测试。

**F1 Part 2 + 校准接线（暂缓，与 F5 合并）**：让未校准 llm_judge 分不进 headline 需要 trust 信号，而 harness 要产出 trust 信号需先有 ground-truth control 桶 → `CalibrationPair` → `computeCalibration` → 挂到 harness run。这是跨 `packages/eval-harness` 的架构件，且该包**在 CI 门外**（F5）——在没进门的包上做校准 gate 是建在沙上。故与 F5（把 harness 纳入门禁）绑定成一个专门批次，不在本轮强做。

### Tier 3 — 结构/CI

**F5a（已完成）**：纠正了原判断——`tests/eval` + `tests/eval-harness` 共 6 文件 40 测试**全 hermetic、2.56s 跑完**（注入 fetch mock / 合成错误 / example.com fixture / mock 掉 grader），今天就能进门。已加进 `eval-harness-gate.yml` 的 vitest run + 触发路径（含 `packages/eval-harness/**`）。堵住"grader/harness 改动无 CI 兜底"的缺口。
> 注：本地全量跑会看到 `artifactRunnableAdapter` / `assertionEngine.artifactRunnable` 两个**真浏览器**测试假红（好标本判 not_runnable=浏览器起不来），这俩**本就在门内、与本改动无关**，是已知本地浏览器争用问题。

**F1 Part 2（判定：现在不必做）**：核实发现整条 harness 判分路径（`packages/eval-harness` → `toCanonicalEvalHarnessResult` → `persistEvalHarnessResult`）**当前零生产调用方、零 src 导入，只有测试碰它**。注意"dormant"≠"跑不了"——代码是好的，随时可接一行调用真跑；只是当下没人调。

**触发口径（看的是"数字被当判决"，不是"能不能跑"）**：
- harness 跑完，人**自己读**结果 → Part 1 已兜住：输出标 `llm_judge` 且无校准=处处显示"未校准"，读的人一眼知道别当能力铁证，不会被静默骗。
- harness 的数字被**喂进自动决策 / 被没跑的人当权威引用**（发版闸 / promote / 看板"能力 82%"）→ 这才是 Part 2 该上的时刻。风险不用等"有人写 CI 集成"，**你手动跑一次、据此下"模型变强了"的结论那刻，数字就承重了**。
- 但"现在"仍不做的硬理由：① 当下没人跑=潜在暴露非活跃暴露；② **今天想做也做不出有用的 Part 2——gate 需要"这裁判可信吗"的信号，而产生它要有金标数据，`CalibrationPair` producer + 金标桶全仓不存在**，硬建只会永远回答"0 可信 case"。真正成本是建金标，只在你决定要靠裁判分下判断时才值得付。

**Part 2 施工包（激活那天连着做，≈1 天 + 金标内容成本）**：
1. `CanonicalEvalRun` 契约加 `judgeCalibration?: CalibrationReport`
2. **金标 producer（三档，按可信度从高到低取）**：
   - **确定性断言 control 桶**（`sampleSplits.ts` 已设计但未接线）：断言结果直接当金标，**零人力、零模型、客观**——主力起点。
   - **多模扩量（仅限有客观答案的题）**：GAIA / 编码 / 事实类，真值锚是客观答案，多模只做"提取/匹配答案"的打标加速器，**不是真值来源**。
   - **人工抽检**：只花在主观 / 多模打架的少数难例。
   - ⚠️ 铁律：**开放式/主观判分绝不能拿"多模共识"当金标**——那量的是模型间一致性不是准确性（两 judge 一起错也高一致），是把 F6/F7 的病换位置再犯。多模可用的唯一前提是锚在可验证真源上（同 model-arena "判分不靠自报靠核实真源"）。
3. `computeCalibration(pairs)` → 挂 `run.judgeCalibration`
4. **headline gate（A/B 决策）**：A=未校准 llm_judge 分不进 passRate/averageScore（破坏性，连累 promote 闸）；**B（推荐）=headline 照旧，另出并列 `trustedPassRate`（只算校准达标 judge 分+确定性分），非破坏**。

**F5b（backlog）**：WebSearch 真答案 fixture 需带 ground-truth 的题库 + 非阻塞 nightly（真网必 flaky），内容工程单独排期。

## 取舍与暂缓理由

- **F3 走止血（skip）而非根治**：止血版即"红线 case 无可用 jail 就 skip"，键 `OS_SANDBOX.ENABLED && getSandboxManager().isAvailable()`——设了 `OS_SANDBOX_ENABLED=true` 且 Seatbelt/bwrap 可用时红线 case 照跑（jailed），否则 skip。已能挡住错题本记的"换更顺从模型跑量真删盘"事故，成本极低。根治（默认在 eval 路径开启 OS 沙箱 / eval 进 Linux 容器）是大工程，单独排期。
- **F5 放最后**：扩大覆盖面价值真但不救急，硬塞 CI 门禁会让门变脆。
- **F6/F7 必须晚于 F1**：不先产出 llm_judge 分，改 judge 输入是空中楼阁。

## 验证

每项 typecheck 必过 + 受影响模块 targeted 测试；F1/F3 高风险项过 `model-arena` 回归对抗审。汇报带全量测试计数（X passed / Y failed / Z skipped）。

## 后果

- 正面：headline pass rate 不再被未校准 judge / skipped / telemetry 丰富度虚抬；红线 case 无 jail 不再真跑，堵住磁盘破坏事故路径。
- 代价：短期 headline 分可能下降（虚高被挤掉，这是预期而非回归）；未开 `OS_SANDBOX_ENABLED` 时红线 case 恒 skip，安全护栏优先于覆盖率——要跑红线覆盖就显式开沙箱或进 Linux 容器（Tier 3）。

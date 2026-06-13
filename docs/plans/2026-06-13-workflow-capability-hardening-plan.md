# 用 Dynamic Workflow 把半成品能力做扎实（含 token 经济设计）

> 创建：2026-06-13
> 背景：2026-06-12 对抗审计 + 2026-06-13 全面问题分析（产品能力/架构/技术债三维）。
> 结论先行：scriptRuntime 已具备 budget / per-call model 路由 / schema 单轮 forced / resumable 缓存 / 三档 tool profile，**基建不缺，缺的是把 Dream/Distill/Checkpoint/Max Mode/验收闸迁移到它上面**，并把 token 分层消费固化为模式。

## 0. Token 经济六原则（所有 workflow 必须遵守）

| # | 原则 | 机制 | 省钱原理 |
|---|------|------|---------|
| 1 | **代码门先于模型门** | 能用 Bash/grep/FTS/测试判定的，在脚本里直接判，不调 `agent()` | 0 token 的判定占比最大化 |
| 2 | **验证一律 schema 单轮** | `agent({schema})` = forced tool_choice 单轮，不跑 agent loop | 单轮 ~1-3K output vs 完整 loop 10-50K，验证类调用降 80%+ |
| 3 | **模型分层：便宜扇出、贵的裁决** | 扇出/起草用 MiMo（eval 一律 MiMo，见 feedback 规则），judge/synthesize 单次用 Kimi K2.5 | 大头（N 个候选）走低价，质量关键点（1 次裁决）走高价 |
| 4 | **budgetTokens 硬上限 + 动态缩放** | 每个 workflow 入参必填 budgetTokens；循环型用 `while (budget.remaining() > X)` 决定轮数/扇出 N | 成本上界可承诺，不会失控 |
| 5 | **失败重跑走 resume** | 出错后 `resumeFromRunId` 重放，已完成 `agent()` 命中缓存 0 token | 调试/迭代脚本不重付已花的钱 |
| 6 | **readonly 默认，写收口到一个 agent** | 扇出候选全部 readonly 输出 patch 文本，唯一 replay/写入 agent 走 edit 档 + SerialWriteGate | 写 agent 上下文最贵（要带文件内容），只养一个 |

## 1. 能力 → Workflow 映射（按优先级）

### P0-A 验收硬门 workflow（最便宜，先做，止血"完成未兑现"）

**问题**：审计实锤 Distill 零交付、Checkpoint 模板糊弄——验收只看"测试绿+typecheck 过"，没有运行证据门。
**方案**：固化一个 `acceptance-gate` workflow 脚本（存 `skills/` 或 `scripts/workflows/`），任何 feature 声称完成时跑：

```
phase('代码门')   // 0 token：typecheck + 相关测试 + grep 交付物存在性（full agent 单个，或脚本侧预检后传入）
phase('运行证据') // 1 个 full agent 实跑 demo（按 feature 的"演示命令"），捕获输出
phase('对抗核验') // 2 个 schema 单轮 refuter（MiMo）：产物是真实运行结果还是模板填充？§段落是否非空？
return { passed, evidence, refutations }
```

**token 预算**：~15-30K/次（1 个 full agent 跑 demo + 2 个单轮 refuter）。
**对应纪律**：把 memory 里"验收三硬规则"（硬门代码化/运行证据硬门）从规则变成可执行资产。

### P0-B Dream / Distill 改造为"候选-验证-落盘"workflow（无人值守不激活）

**问题**：Dream 防幻觉门弱 + cron 自动运行会污染长期记忆；Distill 缺自动模式识别且无交付。
**方案**：两者统一为同一形状的 workflow：

```
phase('候选')   // 1 个 readonly agent（MiMo）从 session 数据提取候选记忆/技能模式
phase('代码核验') // 0 token：脚本侧 FTS/grep 要求候选证据命中同 sessionId 源文本，硬条件不过直接丢弃
phase('对抗验证') // 每候选 2 个 schema 单轮 refuter（MiMo），prompt 要求"默认拒绝，找反证"
phase('落盘')   // 通过的候选：cron 模式只产出 proposal 文件待批；交互模式 1 个 edit agent 写入
```

**关键约束**：cron 触发的 run 永远停在 proposal，不直接写长期记忆（无人值守不激活原则）。
**token 预算**：候选 ~10K + 每候选验证 ~4K，单次 dream run 设 budgetTokens=50K 封顶。

### P1-C Checkpoint 真子代理化（schema forced 正好是为这个场景生的）

**问题**：规格要求 11 段后台 LLM 子代理写入，实际是本地模板，§4 永远 `(none)`。
**方案**：不需要完整 workflow，在 compaction 路径上调 scriptRuntime 的 schema 单轮能力：11 段结构定义成 forced schema（≤16KB 限制内，必要时拆 2 个 schema 调用），MiMo 单轮生成。
**token 预算**：~3-6K/次 compaction，便宜到可以每次都跑。这是把"半成品"补齐成本最低的一项。

### P1-D Max Mode：propose → judge → replay 三段式

**问题**：自修能力弱（repair 轮零改进/负改进），MiMoCode 对标里认定为最值得抄的设计。
**方案**：建在 scriptRuntime 上，不新造特性：

```
const N = Math.max(2, Math.min(4, Math.floor(budget.remaining() / PER_PROPOSE)))  // 预算定扇出
phase('Propose')  // N 个 readonly agent（MiMo/DeepSeek 混搭增加多样性），各自输出 patch 文本 + 自述理由，不落盘 → 天然解决副作用问题
phase('Judge')    // 1 个 schema 单轮（Kimi K2.5）：对 N 个 patch 打分选优，输出 winnerIndex + 理由
phase('Replay')   // 1 个 edit agent 应用赢家 patch（SerialWriteGate 串行写），跑验证命令
phase('Verify')   // 0 token 代码门：测试/typecheck；失败则取次优候选重试一次（budget 允许时）
```

**token 预算**：N=3 时约 propose 3×20K + judge 3K + replay 15K ≈ 80K，budgetTokens=120K 封顶。
**经济开关**：默认关闭，仅在 ①用户显式 `/max` ②repair 检测到连续零改进时自动建议。日常单 agent 路径不涨价。

### P2-E Eval A/B 自动化 workflow（解冻 4-29 以来的停摆）

**方案**：`pipeline(cases, runCase, judgeCase)` 形状，全程 MiMo；budgetTokens 按 case 数线性核定（~15K/case）；产出对比报告落 `docs/knowledge/eval-tracking.md` 格式。把孤儿开关 `CODE_AGENT_DISABLE_PROVIDER_VARIANT` 接进脚本入参做真 A/B。
**经济点**：resumable 让中断的 eval run 续跑不重付；夜间跑用 provider 低峰。

## 2. 前置工程缺口（不修则地基不稳，先做）

| # | 缺口 | 为什么挡路 | 规模 |
|---|------|-----------|------|
| 1 | **Subagent 权限旁路**（gap 分析 G5：ProtocolToolResolver 绕过权限闸/审计） | P0-A/B/D 都靠 workflow 扇出写 agent，旁路不堵等于验收闸自身不可信 | 中：统一收口到 ToolExecutor 管道 |
| 2 | **workflow vs workflow_orchestrate 语义混淆**（债务计划 Iteration 1 未收敛） | 模型/用户选错入口，预算与缓存机制只有命令式有 | 小：完成既有迭代计划 |
| 3 | **可观测性真机 E2E 最后一公里** | 没有真实 token 消耗数据，"经济性"无法被度量和调参 | 小：按 TODOS.md 既有步骤走完 |

## 3. 实施顺序与验收

| 阶段 | 内容 | 验收（每项都过 acceptance-gate） |
|------|------|--------------------------------|
| W1 | 缺口 1+2+3 | subagent 全部调用出现在审计日志；`/workflow` 单一入口文档化；Sentry 看板收到真机事件 |
| W2 | P0-A acceptance-gate workflow + 接入发版前流程 | 用它回验 Dream/Distill/Checkpoint 三件套，产出三份证据报告（预期：复现审计结论） |
| W3 | P0-B Dream/Distill workflow 化 | cron run 只产 proposal；对抗验证拒绝率有数据；budgetTokens 命中率 <80%（没顶到上限） |
| W4 | P1-C Checkpoint schema 化 | §4-§11 段落非空率 100%，单次成本 <6K tokens（telemetry 实测） |
| W5-6 | P1-D Max Mode | 游戏生成 repair 场景 A/B：max mode vs 单 agent repair，分数与 token 成本同表呈现 |
| W7 | P2-E Eval 自动化 | 产出 6 月以来第一份 A/B 对照报告 |

## 4. 成本核算口径

- 每个 workflow run 的 spent() 入 telemetry（telemetryCollector 已有管道），按 workflow 名聚合到 PostHog Run Quality 看板。
- 每阶段验收除功能指标外必报两个数：**单次 run 实际 token 消耗** 和 **schema 单轮调用占比**（目标 >60%，这是经济性的核心代理指标）。

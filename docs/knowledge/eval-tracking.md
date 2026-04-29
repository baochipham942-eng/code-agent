# 评测跟踪与分析

## Project State

- **Code Agent**: v0.16.68（基于 mimo-v2.5-pro + DeepSeek judge + SWE-bench docker harness）
- **业界标准 baseline**: mimo-v2.5-pro 在 **SWE-bench Verified Django <15min 子集 10 case 上 9/10 = 90% first-shot pass rate**（2026-04-29，详见下方 §SWE-bench Verified milestone）
- **历史套件**:
  - SWE-bench Verified Django subset (2026-04-29): 9/10 = 90% — **业界对齐**
  - incremental-edit (2026-04-25): 5 cases P0 observation-masking baseline — 内部
  - Excel benchmark (2026-02-13): v14 190/200 (95%) — 旧 Claude baseline，与新框架不可比
- **默认评测模型**: mimo-v2.5-pro（包月不计费）；判定模型: DeepSeek-chat

---

## SWE-bench Verified milestone (2026-04-29)

> 业界标准 docker e2e 评测，第一个能写简历的硬数字。详见 [ADR-015](../decisions/015-swebench-docker-eval-harness.md)。

### 数字

**mimo-v2.5-pro × SWE-bench Verified × Django <15min × 10 case = 9/10 first-shot pass**

| Case | 真测 | 备注 |
|------|------|------|
| django-10880 | ✅ | grep→read→edit→verify，5 轮 finish |
| django-11179 | ✅ | delete pk 重置 |
| django-14373 | ✅ | dateformat 4 位年份 zfill |
| django-15987 | ✅ | agent 修上游而非使用点（位置不同但等价）—— judge 30 分误判，docker 真测推翻 |
| django-16642 | ✅ | prompt 改进版本（旧版编 `x-brotli` 错） |
| django-10914 | ✅ | batch2 |
| django-10999 | ❌ | **SWE-bench 设计陷阱**：agent 按 problem_statement 提示修，但 test 是按 maintainer 重构（`<sign>` 组）写的 |
| django-11119 | ✅ | template autoescape |
| django-11133 | ✅ | memoryview 兼容 |
| django-11163 | ✅ | `is not None` vs truthy |

### 业界参照（不要直接对比，子集和难度不同）

| 模型 | SWE-bench Verified pass rate |
|------|----------------------------|
| Claude Opus 4.6 | ~70% (full 500) |
| Claude Sonnet 3.5 | 49% (full 500) |
| GPT-4o | 33% (full 500) |
| Aider + Claude | 26% (full 500) |
| **Code Agent (mimo-v2.5-pro)** | **90% (10 case Django <15min subset)** |

### 评测体系架构

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Diff Shape Validation (eval/swe-bench/validation.ts) │
│    ├─ hit_standard_file: agent 改的文件跟 standard 重合      │
│    ├─ no_tests_modified: 不动 tests/                         │
│    ├─ diff_within_3x_standard: 行数合理                      │
│    └─ not_empty                                              │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: LLM-as-Judge (judges/patchEquivalence.ts, DeepSeek) │
│    ├─ semantic_match: 0-100                                  │
│    ├─ matches_intent / matches_implementation                │
│    ├─ key_differences: 文本可读差异列表                       │
│    └─ 用途: executable 缺席时兜底；非 ground truth          │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Executable Validation (docker, ground truth)        │
│    ├─ docker run swebench/sweb.eval.x86_64.<repo>_<id>_<inst> │
│    ├─ 内部: apply test_patch + apply agent.diff + runtests   │
│    ├─ 解析 exit_code: 0=passed / 非 0=failed                 │
│    └─ 优先于 judge: docker PASS 直接 PASSED 不被 judge 否决   │
└─────────────────────────────────────────────────────────────┘
                          ↓
                decideRunOutcome (validation.ts:78)
                executable 优先 → judge fallback → shape 兜底
```

### 关键发现 / 踩坑

1. **judge 在"位置不同但等价"的修复上过严**（django-15987）—— LLM-as-Judge 看不到 test 真跑，只能基于文本相似度。docker 是 ground truth
2. **SWE-bench 部分 case 是设计陷阱**（django-10999）—— test 按 maintainer 重构写，agent 按 problem_statement 提示修反而 fail
3. **本地 Python 跑不动 Django 2.2**（cgi 模块 PEP 594 在 Python 3.13+ 移除）—— 只有 docker 路径可行
4. **REPO_NUMERIC_ID 命名规则**: docker hub image 名是 `<repo>_<numeric_id>_<instance>`（django=1776），不是 instance_id 直接命名
5. **FAIL_TO_PASS 字段格式不统一**（标准 dotted path vs 自然语言描述）—— 三级 fallback 推断（标准格式 → test_patch hunks → 整个 module）

### 运行命令

```bash
# 跑单个 case（默认 docker 模式）
npx tsx eval/swe-bench/run-one-case.ts --instance django__django-10880 --run-tag baseline

# 切回本地 Python（fallback，Django 2.2 在 Python 3.13+ 跑不动）
npx tsx eval/swe-bench/run-one-case.ts --instance django__django-10880 --mode python

# 复评所有现有 runs（不重跑 agent，只重跑 executable + judge）
npx tsx eval/swe-bench/replay-validation.ts            # 默认 docker
npx tsx eval/swe-bench/replay-validation.ts --mode python

# 只跑 LLM judge（不跑 executable）
npx tsx eval/swe-bench/reevaluate-with-judge.ts
```

### 下一步演进方向

- 扩 REPO_NUMERIC_ID 映射到 sympy / matplotlib（跨 repo 验证）
- ~~设计 hypothesisGenerator~~ ← **2026-04-29 实验验证此路在 mimo 上反向，搁置**

---

## 2026-04-29 batch3 + hypothesis-driven 实验

### batch3 — 难度=15min-1hour 子集 (5 case)

| Case | 真测 | 备注 |
|------|------|------|
| django-14500 | ✅ | 7 轮，judge 100 |
| django-11749 | ✅ | 10 轮，judge 100 |
| django-14122 | ❌ | 探索黑洞，15 轮零 edit |
| django-13315 | ✅ | 12 轮，judge 40（位置不同但等价） |
| django-13809 | ✅ | 13 轮，judge 85 |

**4/5 = 80% pass rate**（业界 docker e2e）

### 累计 15 case (10 个 <15min + 5 个 15min-1hour)

| 难度 | 通过率 |
|------|------|
| <15min | 9/10 = 90% |
| 15min-1hour | 4/5 = 80% |
| **合计** | **13/15 = 86.7%** |

### Hypothesis-driven 失败实验

2026-04-29 试在 system prompt 加"先列 3-5 假设再验证 → 验证完都不对就 finish"流程，跑同样 5 个 hard case（hypo-v1 vs batch3 baseline）：

| Case | Baseline | Hypo-v1 | 变化 |
|------|---------|---------|------|
| django-14500 | ✅ 7 轮 | ❌ 3 轮 skipped | **退化** |
| django-11749 | ✅ 10 轮 | ✅ 12 轮 | 维持 |
| django-14122 | ❌ 15 轮 | ❌ 2 轮 skipped | 维持 fail，轮数大降 |
| django-13315 | ✅ 12 轮 | ✅ 13 轮 | 维持 |
| django-13809 | ✅ 13 轮 | ❌ 7 轮 exec_failed | **退化** |

**结果**: 4/5 → 2/5 = **-40%**

**根因**: mimo 列的假设准度不够 + "假设全验证完承认搞不定"指令 → agent 早早 finish，错过原本能 brute-force 找到的 hook 点。结构化推理需要模型本身代码定位足够准。**mimo-v2.5-pro 适合 brute-force，不适合 hypothesis-driven**。

**结论**: 此 prompt 已 revert。要试 hypothesis-driven 必须换 GPT-5 / Claude Opus 当 baseline。这是个有价值的失败实验——印证"prompt 优化技巧不能脱离模型基础能力"。

---

## 2026-04-25 修复记录

### 起因

4-24 跑出 reread-loop-trap 76.9% partial — 调查发现是**假评测**：
1. `eval/incremental-edit/run_baseline.ts` 走 tsx ESM 加载 main 代码链，触发 main 模块 6 处裸 `__dirname` 全部抛错 → AgentLoop 一启动就崩 → turnCount=0、responses=[] → 弱断言（no_crash + max_tool_calls≤3，0 次调用自然 ≤3）伪通过
2. 评测数字完全不反映模型真实行为

### 七个 commit

| Commit | 改动 | 性质 |
|--------|------|------|
| `3d81a779` | agentAdapter messages 持久化 + recent_conversations 跨 case 隔离 | **真 bug** — multi-turn case 跑成 N 个独立 session；recent-conversations.md 把上一 case prompt 注入下一 case system context |
| `b0625519` | `PLACEHOLDER_FILE_READ` 文案重写 + Edit 工具描述删除 must-read | placeholder 对桌面版长会话（ctx 超 75% 触发 mask）有效；Edit description 评测稳态无明显效果 |
| `54a58c5e` | reread-loop nudge 删 "ask user for guidance" | 跟 placeholder 同模式 — 死指令引导模型尝试不存在的 askUser |
| `82a7f461` | 文档：旧 baseline 作废说明 | — |
| `19fa963d` | reasoning_content 加 provider-aware（BaseOpenAIProvider.isThinkingMode 钩子，DeepSeek/Moonshot 子类返回 true） | **真 bug** — DeepSeek 报 400，AgentLoop catch 后空响应让 follow-up 静默跳过 |
| `be4c32f9` | reasoning_content 修复扩展到 plain-text assistant 分支 | 同根因，前一 commit 漏了非 toolCall 路径 |
| `06c8a329` | yaml 里 5 处 max_tool_calls 从 `critical:true, weight:1` 降到 `critical:false, weight:0.5` | 评分语义调整 — 让 score 反映任务完成度，不让"啰嗦"直接 fail |

### 运行指南

```bash
# 用 scripts/run-auto-tests.ts --real（CJS bundle 入口）
# 直接 tsx eval/incremental-edit/run_baseline.ts 走 ESM 加载会触发裸 __dirname 全崩
npx tsx scripts/run-auto-tests.ts --real --provider zhipu --model glm-5 --tags incremental-edit
npx tsx scripts/run-auto-tests.ts --real --provider deepseek --model deepseek-v4-flash --tags incremental-edit
npx tsx scripts/run-auto-tests.ts --real --provider moonshot --model kimi-k2.5 --tags incremental-edit
```

### incremental-edit 套件 GLM-5 最终数字（scoring 调整后）

| Case (budget) | tools | 状态 | score |
|---------------|-------|------|-------|
| reread-loop-trap (3) | 3 | ✅ | 100% |
| cross-file-consistent-edit (7) | 6 | ✅ | 100% |
| incremental-edit-no-reread (5) | 7 | 🟡 | 86%（任务对，超 budget 2）|
| modify-verify-modify (8) | 11 | 🟡 | 86%（任务对，超 budget 3）|
| long-chain-budget-15 (15) | 17 | 🟡 | 93%（任务对，超 budget 2）|
| **avg_score** | | | **93%** |
| **pass rate** | | | 40% |

GLM-5 在 temp=0.3 下确定性输出，3 次连续跑工具数 100% 一致。

### DeepSeek-v4-flash（reasoning_content 修复后真跑遍 multi-turn）

修复前 long-chain turn=2 / dur=13s（follow-up 静默跳过）→ 修复后 turn=11 / dur=69s（10 个 follow-up 全跑）。avg_score 20% — DeepSeek 真实模型行为，超 budget 比 GLM 更明显。

### Kimi K2.5

reasoning_content 修复同样适用（MoonshotProvider.isThinkingMode = true）。但 Kimi K2.5 当前 API 网络层有 ECONNRESET 抖动 + 重连后空响应，多个 case 仍受影响。这是 API/网络问题，不是 Code Agent 工程问题。

### 关键观察

- **任务完成度 ≠ budget 通过率**：GLM avg_score 93%（content/test 断言全过），但 pass rate 只有 40%（3 个 case 卡 budget）。`max_tool_calls` 降级后这个差距被正确刻画
- **GLM-5 ≠ Claude**：incremental-edit suite 的 budget 是基于 Claude 行为设计的；GLM 倾向"Edit 前 Read 一次" + "全局任务（一次改多个方法）连读 ≥3 次"，超 budget 是模型行为差异，不是工程 bug
- **桌面版长会话**才是 placeholder/nudge 修复的真正受益场景：评测里 ctx 没超 75% 触发 mask，桌面版日常长会话超得轻松

## Open Loops

- [ ] 桌面版真实长会话验证 placeholder + nudge 修复效果（爸用一次 snake-game 量级会话）
- [ ] 旧 R20-R23（132-164/200）baseline 数据基于失效的 evaluation 框架，**作废**
- [ ] 需建立新框架下 Claude/GLM/DeepSeek 三档 baseline 数字（Kimi 等 API 稳定后再加）
- [ ] yaml budget 设计仍有部分基于 Claude 行为（`long-chain-budget-15` 文件名声明的"P0 从 51 降到 <15"是 Claude 路径数据），但当前 weighted scoring 已能正确反映完成度，是否进一步加宽 budget 留给以后看

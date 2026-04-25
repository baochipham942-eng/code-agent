# 评测跟踪与分析

## Project State

- **Code Agent**: v0.16.65 (commits 3d81a779 / b0625519 / 54a58c5e / 82a7f461 / 19fa963d / be4c32f9 / 06c8a329 on 2026-04-25)
- **最新评测套件**: incremental-edit (5 cases, P0 observation-masking baseline)
- **历史最高**: v14 190/200 (95%), v19 189/200 (94.5%), v28 188/200 (94%) — 旧 Claude baseline，与新框架不可比
- **默认模型**: claude-sonnet-4-6（2026-03-08 升级）

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

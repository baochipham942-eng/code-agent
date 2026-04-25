# 评测跟踪与分析

## Project State

- **Code Agent**: v0.16.65 (commits 3d81a779 / b0625519 / 54a58c5e on 2026-04-25)
- **最新评测套件**: incremental-edit (5 cases, P0 observation-masking baseline)
- **历史最高**: v14 190/200 (95%), v19 189/200 (94.5%), v28 188/200 (94%) — 旧 Claude baseline，与新框架不可比
- **默认模型**: claude-sonnet-4-6（2026-03-08 升级）

## 2026-04-25 修复记录

### 起因

4-24 跑出 reread-loop-trap 76.9% partial — 调查发现是**假评测**：
1. `eval/incremental-edit/run_baseline.ts` 走 tsx ESM 加载 main 代码链，触发 main 模块 6 处裸 `__dirname` 全部抛错 → AgentLoop 一启动就崩 → turnCount=0、responses=[] → 弱断言（no_crash + max_tool_calls≤3，0 次调用自然 ≤3）伪通过
2. 评测数字完全不反映模型真实行为

### 三个 commit

| Commit | 改动 | 性质 |
|--------|------|------|
| `3d81a779` | agentAdapter messages 持久化 + recent_conversations 跨 case 隔离 | **真 bug** — multi-turn case 一直在跑成 4 个独立 session；recent-conversations.md 把上一 case prompt 注入下一 case system context |
| `b0625519` | `PLACEHOLDER_FILE_READ` 文案重写 + Edit 工具描述删除 must-read | placeholder 对桌面版长会话（ctx 超 75% 触发 mask）有效；Edit description 评测稳态无明显效果 |
| `54a58c5e` | reread-loop nudge 删 "ask user for guidance" | 跟 placeholder 同模式 — 死指令引导模型尝试不存在的 askUser |

### Kimi K2.5（应使用 `scripts/run-auto-tests.ts --real`，CJS 入口）

- `npx tsx scripts/run-auto-tests.ts --real --provider zhipu --model glm-5 --tags incremental-edit`
- `--provider moonshot --model kimi-k2.5` 同理

### incremental-edit 套件 GLM-5 baseline（修复后）

3 次连续跑 100% 一致（GLM-5 在 temp=0.3 下确定性输出）：

| Case (budget) | tools | 状态 |
|---------------|-------|------|
| reread-loop-trap (3) | 3 | ✅ |
| cross-file-consistent-edit | 6 | ✅ |
| incremental-edit-no-reread (5) | 7 | ❌ |
| modify-verify-modify (8) | 11 | ❌ |
| long-chain-budget-15 (15) | 17 | ❌ |
| **Pass rate** | | **40%** 稳态 |

### 关键观察

- **GLM-5 ≠ Claude**：incremental-edit 套件的 budget 是基于 Claude 行为设计的；GLM 倾向"Edit 前 Read 一次"+"全局任务（一次改多个方法）连读 ≥3 次"，超 budget 是**模型行为差异**，不是工程 bug
- **Kimi K2.5 失败模式正交**：Kimi 几乎不超 budget，但 content_contains/test_passes 失败（Edit 内容不全）
- **桌面版长会话才是工程真痛点**：ctx 超 75% 触发 mask 后 placeholder/nudge 反向引导模型重读，已修

## Open Loops

- [ ] 桌面版真实长会话验证 placeholder + nudge 修复效果（爸用一次 snake-game 量级会话）
- [ ] incremental-edit 套件部分 case budget 设计基于旧 Claude 行为，需重审是否仍合理（参考 `long-chain-budget-15` 文件名声明的"P0 从 51 降到 <15"是 Claude 路径下数据）
- [ ] 旧 R20-R23（132-164/200）baseline 数据基于失效的 evaluation 框架，**作废**
- [ ] 需建立新框架下 Claude/GLM/Kimi 三档 baseline 数字

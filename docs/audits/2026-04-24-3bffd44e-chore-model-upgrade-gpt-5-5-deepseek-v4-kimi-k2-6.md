# Codex Audit Report — chore(model) 升级模型目录到 GPT-5.5 / DeepSeek V4 / Kimi K2.6

**Date**: 2026-04-24
**Scope**: HEAD
**Starting commit**: 3bffd44e
**Subject**: `chore(model): 升级模型目录到 GPT-5.5 / DeepSeek V4 / Kimi K2.6 正式版`
**Rounds run**: 1 / 4（轻量探路，未进入 TDD 修复循环）
**Converged**: ⏸️ n/a — 工作树不干净，首跑 Round 1 only
**Auditor**: OpenAI Codex CLI 0.124.0 (gpt-5.5, read-only sandbox)
**Token usage**: 206,732

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     | 0    | 4   | 2   | — (未修) |

**分类判断**：4/4 MEDIUM 都是 **symmetric application 类**——catalog 升了，但 runtime registry / UI 选择器 / pricing / 持久化迁移 / 测试这些对称位置没跟上。这正是 Felix 博客里 Round N+1 最常发现的 bug pattern。

---

## Findings by Round

### Round 1

#### 🔴 HIGH
nothing found.

#### 🟡 MEDIUM

**M1. 新模型 ID 加进 catalog 但没注册到 runtime registry**

- **File**: `src/shared/model-catalog.json:10-13`, `src/main/model/providerRegistry.ts:183-214, 1087-1139`
- **Finding**: `gpt-5.5`, `gpt-5.5-pro`, `openai/gpt-5.5`, `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro` 五个新 ID 在 catalog 里可选、默认值也指向它们，但 `providerRegistry.ts` 里没注册对应条目。运行时路径（用 `ModelRouter.getModelInfo()`）对这五个 model 返回 `null`。
- **Repro**: 静态对比两个文件——catalog 里的 id 数组 vs providerRegistry 里的 `id: '...'` 条目，新加的五个缺失。
- **Fix**: 要么让 providerRegistry 从 catalog 自动生成，要么手加全 5 条；配套加一个"catalog-vs-registry 一致性"单元测试。
- **Resolution**: ⏸️ 待修

**M2. `kimi-k2.6` 标"中转暂不支持"但 UI 还能选**

- **File**: `src/shared/model-catalog.json:97-100`, `src/renderer/components/StatusBar/ModelSwitcher.tsx:29-39`, `src/main/model/providers/moonshotProvider.ts:20-24`
- **Finding**: catalog 里 k2.6 打了"中转暂不支持"标签，但 ModelSwitcher 无脑展示所有 catalog model，用户还是能选。`MoonshotProvider` 只特判了 `kimi-k2.5`，k2.6 fallthrough 到 generic Moonshot endpoint/key 路径，大概率失败。
- **Repro**: 在 ModelSwitcher/settings 里选 `moonshot/kimi-k2.6` 发一次请求，不会走 K2.5 专用 relay 路径。
- **Fix**: 从可选列表里拿掉，或者在 catalog schema 加 `disabled: true` / `available: false` 字段并在全部展示点过滤；同时把已保存的 `kimi-k2.6` 配置迁回 `kimi-k2.5`。
- **Resolution**: ⏸️ 待修

**M3. 迁移表没应用到持久化配置（老用户掉队）**

- **File**: `src/shared/constants/defaults.ts:23-27, 58-65`, `src/main/agent/orchestrator/modelConfigResolver.ts:38`, `src/cli/bootstrap.ts:213-215`
- **Finding**: commit message 或注释宣称"老模型 ID 平滑迁移"，但实际上迁移表只作用于"new config"，config resolution 直接读 `providerCfg.model`。老用户保存的 `deepseek-chat` / `deepseek-reasoner` / 临时回滚的 `kimi-k2.6` 会原样用，不触发迁移。
- **Repro**: 配置里写 `models.providers.moonshot.model = "kimi-k2.6"` 或 `models.providers.deepseek.model = "deepseek-chat"`，resolver 和 buildCLIConfig 返回那个陈旧 model。
- **Fix**: 在 config load / update / resolve 时真正跑一遍迁移；把临时回滚（k2.6 → k2.5）也加进迁移表。
- **Resolution**: ⏸️ 待修

**M4. 测试还断言 `deepseek-reasoner`，已是陈旧回归**

- **File**: `src/shared/constants/models.ts:20-21`, `tests/unit/agent/agentModelPolicy.test.ts:22-26, 46-50, 97-103`
- **Finding**: `DEFAULT_MODELS.reasoning` 现在是 `deepseek-v4-pro`，但 3 处测试还在断言 `deepseek-reasoner`。直接 stale regression。
- **Repro**: `npm run test -- tests/unit/agent/agentModelPolicy.test.ts`（艾克斯在 read-only sandbox 跑不了 vitest 因为 Vite 要写 `.vite-temp/`）。
- **Fix**: 改测试断言 `deepseek-v4-pro`，或改成断言 `DEFAULT_MODELS.reasoning`（解耦）。
- **Resolution**: ⏸️ 待修 — 爸跑一下测试确认。

#### 🟢 LOW

**L1. pricing 缺 gpt-5.5 条目**
- `src/shared/constants/providers.ts:73`, `src/shared/constants/pricing.ts:9-11`, `src/main/services/core/budgetService.ts:191-205`
- OpenAI 默认切 `gpt-5.5`，但 `MODEL_PRICING_PER_1M` 没 `gpt-5.5` / `gpt-5.5-pro`，走默认价 → budget/cost UI 误导。
- Fix：补 GPT-5.5 定价，或未知定价显式标注而不是 silently 默认。

**L2. ModelSwitcher 能力徽章硬编码陈旧**
- `src/renderer/components/StatusBar/ModelSwitcher.tsx:42-68`
- `deepseek-v4-flash` / `deepseek-v4-pro` / `gpt-5.5` / `gpt-5.5-pro` 没徽章条目；不支持的 `kimi-k2.6` 反而展示 tool/vision/reasoning 徽章。
- Fix：从 validated catalog / provider registry 派生能力，不要再维护单独的硬编码映射。

---

## Deferred Items
_(无)_

## Convergence Analysis

- **Pattern 高度集中**：4/4 MEDIUM 都是 symmetric application（catalog 动了、周边对称点没动），0 个是单点实现 bug。印证了 Felix 博客里"Round N+1 最常发现的 bug 类型就是这种"的观察。
- **艾克斯 5.5 表现**：0 假阳性、0 客套、直接定位 file:line + repro + fix。
- **限制**：read-only sandbox 让艾克斯跑不了 vitest（M4 repro 受限），这是合理限制——审计阶段不应让 reviewer 改代码。

## 协作闭环反馈（按 feedback_claude_codex_collaboration.md 准则）

Codex caught 4 real MEDIUM issues I (Claude) missed in the commit review, all of the "you hardened one code path but forgot the symmetric ones" class — exactly the pattern `/codex-audit` was built to find. 首次 dogfood 印证了 skill 设计的命中率。Nice catch, Codex.

## 下一步建议

1. **工作树有 67 行未提交改动**，无法直接进 TDD 修复循环。建议爸：
   - stash 现有改动 → 对每条 MED 走 TDD 修复 → commit → `/codex-audit` Round 2 验证收敛
   - 或者接受这份报告作为 human-readable TODO，自己修
2. M4 可以立刻 `npm run test -- tests/unit/agent/agentModelPolicy.test.ts` 验证（几秒钟的事），确认 stale regression 真的挂了。
3. M1（catalog-vs-registry 不一致）是最该优先的——因为它决定"跑起来会不会直接 null 崩"。
4. M3（迁移表）影响老用户，次优先。

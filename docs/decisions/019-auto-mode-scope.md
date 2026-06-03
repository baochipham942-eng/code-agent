# ADR-019: 自动模式（Auto Mode）的能力边界与取舍

> 状态: accepted
> 日期: 2026-06-02

## 背景

"自动"模型模式（adaptiveRouter）2026-06-02 刚修复三个失效根因（adaptive 标志不透传 / CLI_MODE 守卫误伤 / custom provider 能力检查失明，commit 291d85c82 + 0b05bd729）。修复过程中暴露出更深层的设计问题：

1. 项目里实际存在**两套**模型选择系统——
   - **系统 A**（adaptiveRouter）：用户选"自动"时按消息复杂度启发式路由（simple → 免费模型 glm-4-flash）+ 能力 fallback（vision）+ 错误降级链
   - **系统 B**（subagent 角色分层）：explore/awaiter → 免费模型、reviewer/plan → glm-5、coder → 主力模型，始终生效
2. 路由发生后用户无任何 UI 感知（用了哪个模型、为什么）
3. adaptive 标志会通过 `...ctx.modelConfig` spread 泄漏进 subagent 配置，且两条推理引擎（AI SDK / legacy modelRouter）对它的处理不一致
4. 价格表（MODEL_PRICING_PER_1M）是手工硬编码，"免费"语义混乱（glm-4-flash 真免费 vs kimi-k2.5 因用户包月才标 0），且路由决策根本不读价格表

行业背景（2026-06 调研）：Cursor/Copilot/Windsurf 的 auto 全部是"省钱降级 + 可用性兜底"方向，无人做向上路由；GPT-5 router 翻车主因是不透明；Copilot 的正面经验是 hover 显示实际模型；大厂趋势是放弃跨模型路由、转向模型内自适应思考。QCon 实测数据（白海科技）：按任务阶段路由（规划用强模型、摘要用轻模型）是 ROI 最高的单一降本策略（$10 → $0.9/次）。

本决策由四模型讨论得出（Claude / Codex / Kimi K2.5 / Gemini 3 Flash 各自独立回答同一份 brief 后综合裁决），讨论 brief 与原始回复见 `/tmp/auto-mode-discussion-brief.md`（会话产物，结论以本 ADR 为准）。

## 决策

### 1. 主从关系：系统 B（角色分层）为主干，系统 A 降级为"拦截器"

- 角色路由是**确定性业务逻辑**：任务阶段天然对应成本/质量要求，可解释、可预判
- adaptiveRouter 是**非确定性补丁**，只在两种情况介入：
  - **能力补齐**：主模型不支持 vision 但消息带图 → 视觉模型预处理
  - **可用性兜底**：限流 / 网络错误 / **余额不足** → 跨 provider 降级链
- adaptive 标志**不得覆盖** subagent 角色分层（legacy 引擎中的覆盖行为删除）

### 2. simple → 免费模型路由：按计费方式门控，不做一刀切

- 主力模型**按量付费** → 路由生效（真省钱）
- 主力模型**包月/订阅** → 路由默认关闭（省的钱是 0，纯增加不确定性）
- 依赖"计费语义四分类"（见决策 4）

### 3. 硬约束：自动模式永远不选比用户默认模型更贵的模型

写进代码层约束，不是产品文案。消除 BYOK 场景下"意外高额账单"的信任风险。

### 4. 计费语义重构：替代"价格感知路由"

不做价格感知路由（BYOK 场景下价格表不可维护），改为四分类标记：

| 分类 | 示例 | 来源 |
|------|------|------|
| provider 官方免费 | glm-4-flash | 全局常量 |
| 用户套餐内（包月） | kimi-k2.5（当前用户） | **用户设置** |
| 低成本按量 | deepseek-chat | 全局常量 |
| 未知价格 | custom 中转站 | 默认值 |

"市场价"是全局常量，"用户的计费方式"是用户配置，两者分离。成本统计和路由门控都从后者读。

### 5. 改进优先级（P1-P3 排进下个迭代）

| # | 改进 | 内容 |
|---|------|------|
| P1 | **透明度 trace** | 路由 chip 默认收起（"自动 · 已用 GLM-4-Flash 回答 · 免费 ▸"），点击展开决策详情卡；subagent 任务卡常驻模型标签；降级横幅原位插入聊天流。StatusBar 保持现状不加内容 |
| P2 | **单一路由决策入口** | 所有路由决策输出结构化结果 `{requestedModel, resolvedModel, provider, reason, role, fallbackFrom, billingMode}`，UI/日志/token 统计统一消费；收口两引擎不一致 + 修 adaptive 泄漏 + 计费语义四分类 |
| P3 | **Output 精控** | subagent 中间轮次只返回结构化摘要、设更短 max output（output 单价是 input 的 3-5 倍） |

### 6. 原型评审修正（2026-06-02，原型见 docs/designs/auto-mode-ui-prototype.html）

1. **角色分层去硬编码（分发前提）**：角色映射到抽象档位（免费档/标准档/主力档），档位在运行时按用户已配置的 provider 解析。`coreAgents.ts` 里 `fast→zhipu/glm-4-flash` 这类硬编码必须改掉——分发给没配智谱 Key 的用户会直接坏
2. **计费方式默认值**：新 Key 默认**按量付费**（API Key 主流形态，省钱路由默认生效），中转站默认"未知"（保守）。配错的代价不对称：包月用户被路由 = 没省到钱但不多花钱；按量用户不路由 = 损失真实节省
3. **价格档位 + 数据源**（回答"Opus 一定比 DeepSeek 贵，系统怎么知道"）：
   - 硬约束的"贵/便宜"比较用 5 档价格带（免费 / $ / $$ / $$$ / $$$$ 旗舰），不依赖精确数字
   - 数据源：LiteLLM 社区价格库（`model_prices_and_context_window.json`），打包内置快照 + 周更拉取 + 离线兜底；替代手工维护的 `MODEL_PRICING_PER_1M`
   - 中转站模型按同名官方模型归档（claude-opus-4-8 走中转 = 仍是旗舰档）
4. **降级文案纠偏**：Neo 消息历史是模型无关的，切 provider **不丢上下文**；横幅只说"回复风格可能略有差异"，不夸大成"影响上下文连续性"（推翻讨论中 Gemini 的"失忆"说法）
5. **Provider 视觉**：复用项目已有的 `providerLogoCatalog.ts`（20+ 家官方 SVG），不用字母占位

### 明确不做

- ❌ 向上路由（complex → 更强模型）
- ❌ 价格感知路由（定量价格计算）
- ❌ 语义缓存（单人维护成本不划算）
- ❌ LLM router（行业验证启发式够用）

### Backlog（不进本轮）

- 轮次收敛（信息增益阈值提前终止 agent loop）
- 成本预警式人机协作路由（超长消息时提示"建议切换长文本模型"而非自动切，贴合 cowork 定位）
- Ollama 本地模型兜底（桌面端差异化，但扩大维护面）

## 选项考虑

### 选项 1: 保持现状（A/B 两套并行，互不感知）
- 优点: 不用改代码
- 缺点: 引擎不一致 + 标志泄漏继续存在；用户不知道发生了什么；同一设置在不同路径行为不同，反馈无法复现

### 选项 2: 把 adaptiveRouter 做强（LLM router / 价格感知 / 双向路由）
- 优点: 技术上更"智能"
- 缺点: 行业反面教材（GPT-5 router）；BYOK 价格表不可维护；向上路由放大账单信任风险；单人维护扛不住

### 选项 3: 角色分层为主 + adaptiveRouter 缩为拦截器（采纳）
- 优点: 可解释、可预判；与行业验证的高 ROI 路由方式一致；维护面最小
- 缺点: "自动"模式的产品故事从"智能路由"变成"稳定兜底"——但这恰恰是更诚实的定位

## 后果

### 积极影响
- 用户能看到并理解每次模型切换（信任）
- 路由行为可预判、可复现（可维护性）
- 包月用户不再被无意义的 simple 路由打扰
- 调度透明度成为产品差异化点（业内 auto 全是黑盒）

### 消极影响
- adaptiveRouter 的复杂度评分逻辑（estimateComplexity）价值下降，长期可能整体移除
- 需要用户在设置中标记 provider 计费方式（一次性配置成本）

### 风险
- 跨 provider 降级会导致上下文连续性受损（不同模型 prompt 偏好不同）——P1 的降级提示是缓解措施，完整的上下文重同步逻辑留待后续
- 余额不足检测依赖各 provider 错误码的差异化解析，国产 provider 错误码不规范

## 产品定义（一句话）

> Auto 不是帮用户挑最强模型，而是在用户边界内，用更便宜、更稳定、更合适的方式完成当前阶段。

## 相关文档

- [ADR-011 聊天原生工作台](011-chat-native-workbench.md)
- `src/main/model/adaptiveRouter.ts` / `src/main/model/modelRouter.ts`（系统 A）
- `src/main/agent/hybrid/coreAgents.ts` / `src/main/agent/agentDefinition.ts`（系统 B）
- `src/shared/constants/pricing.ts`（价格表，待按本 ADR 决策 4 重构）

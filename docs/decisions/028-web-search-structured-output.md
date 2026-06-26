# ADR-028: WebSearch 结构化证据输出

> 状态: deferred
> 日期: 2026-06-26

## 更新 2026-06-26（deferred 决议）

P0/P1 合并后跑了一轮 live eval（每类各 1 条真实搜索）。结论是结构化输出的边际价值已显著下降，故**暂缓**本 ADR，不立即改 tool result 契约：

- citation 已恢复且**标签质量高**（真实标题，非裸 URL），markdown URL 抽取在实测中已够用——“证据绑定的稳定 citationId”相对现状的增量收益比预估小。
- provider 失败已对用户可见（markdown `sources failed` note），且聚合优雅降级实测有效（perplexity 401 / exa 402 均不阻塞）。
- 第 7 步剩余的真增量仅 search trace 面板 + 未来 hosted trace 契约落脚，属锦上添花、非关键缺口。
- 本 eval 仅覆盖“管道层”（引用/源/失败是否正确捕获），**未覆盖答案 grounding 质量**；若后续要提升“claim 必须由证据支撑”，优先走计划 §6 的 prompt policy 切片（不改契约、成本低），而非本 ADR。

重新启用条件：产品需要结构化引用 UI / trace 面板，或 P2 hosted trace 映射需要稳定契约时，再恢复 proposed 推进。下方原提案内容保留备查。

---

## 背景

`WebSearch` 已完成 P0/P1 的基础修复：工具名别名归一、引用抽取恢复、外部数据 sanitizer 覆盖、recency 强度标记、provider health/cooldown 路由、query plan 与结果评分。当前剩余问题在结果契约层：

- 工具结果仍以 markdown `output` 为主，结构化 `result` 没有稳定版本和字段边界。
- `citationService` 已按 session 存储 citation、mint `cite_*` id、发送 `citations_updated` 事件，但 WebSearch citation 仍主要从 markdown URL 正则抽取，不能稳定绑定到具体 evidence。
- renderer 的 WebSearch 摘要和 citation 消费方依赖现有输出形态，直接改 payload 会牵动 UI、history sanitizer、tool observation、eval 基线。
- 计划文档要求第 7 步改 tool result 契约前先写 ADR 并等待确认。

## 决策

建议采用版本化结构化 payload，并保持 markdown 输出兼容。

1. `ToolExecutionResult.output` 继续保留 markdown，可作为模型 observation、旧 renderer、日志和人工阅读 fallback。
2. `ToolExecutionResult.result` 对 `WebSearch` 使用 `WebSearchStructuredResultV1`，字段固定为：
   - `schemaVersion`: `1`
   - `query`: 原始 query
   - `queryPlan`: intent、planned queries、source expectations
   - `results`: 搜索结果证据列表，含 `url`、`title`、`snippet`、`source`、`publishedAt/age`、`score`、`scoreReasons`、`citationId`
   - `extractions`: 抓正文结果，含 `url`、`status`、`contentPreview`、`contentHash`、`citationId`
   - `failures`: provider/query 级失败，含 `provider`、`query`、`code`、`retryable`、`cooldownMs`
   - `citations`: `citationService` 返回的 `Citation[]`
   - `trace`: `SearchTrace`，记录 provider attempts、selected sources、cooldown skips、routing reason、recency enforcement、后续 hosted trace 映射入口
3. `citationService` 扩展结构化入口，例如 `storeStructuredWebSearchCitations(sessionId, toolCallId, evidence)`。它负责生成和复用 `citationId`，并继续通过既有 `citations_updated` 事件通知 UI。
4. citation id 的稳定性限定在 session 内：以 `toolCallId + normalizedUrl + title/snippet hash + extraction hash` 作为 evidence fingerprint，避免同一次工具结果内重复 URL 生成多个 citation。
5. 不新增 `EvidenceLedger`。证据引用、事件广播、renderer 消费继续围绕 `citationService` 演进。
6. hosted web search 仍是增强型对等源。未来 Anthropic/OpenAI 原生 trace 统一映射到 `SearchTrace`，不改变多源 routing 的基本形态。
7. 结构化 payload 不得包含 raw API key、auth header、完整 HTML、过长正文或未截断的 provider 原始响应。进入 history/model observation 的内容仍走现有 sanitizer 和 history size sanitizer。

## 选项考虑

### 选项 1: 继续 markdown-only

- 优点: 改动最小，renderer 和模型 observation 完全不动。
- 缺点: citation 只能靠 URL 正则抽取，无法表达 provider failure、score reason、trace、extraction 与 citation 的绑定关系。

### 选项 2: 新建 EvidenceLedger

- 优点: 可以给证据建一套独立索引和生命周期。
- 缺点: 与现有 `citationService` 重叠，会制造第二个引用真相来源，也违背计划文档第 12 节结论。

### 选项 3: 扩展 citationService + 版本化 WebSearch result

- 优点: 复用现有 session 存储、citation id、事件和 UI 消费；结构化字段可测试；markdown fallback 留住兼容性。
- 缺点: 需要同步更新 shared 类型、tool result lifecycle、renderer summarizer/citation UI、history sanitizer 和 eval。

建议选项 3。

## 后果

### 积极影响

- 每条 evidence 可直接绑定 `citationId`，不再靠 markdown URL 抽取猜测。
- renderer 可以展示来源质量、失败原因、trace 和引用，模型仍能读到 markdown fallback。
- 后续 hosted 原生 trace 有统一落点，不会把 hosted web search 升成特殊主路径。

### 消极影响

- 这是 tool result 契约变化，需要更严格的 shared type 和 renderer 回归测试。
- 结构化 payload 会增加结果体积，需要对 snippets、extractions、trace 做长度上限。
- 旧会话或旧日志里没有 `schemaVersion`，消费方必须继续支持 legacy markdown-only。

### 风险

- 如果 citation id 在 service 与 result payload 中不同步，UI 会出现引用 chip 与 evidence 对不上。
- 如果 sanitizer 只看 `output`，未来把 structured snippets 注入模型上下文时可能绕过外部数据防线。
- 如果 trace 记录 provider 原始错误过多，可能泄漏 key index、quota 细节或过量内部状态。

## 实施约束

在获得确认前，不改协议代码。确认后按以下顺序推进：

1. 新增 shared contract 类型和 size/redaction 常量。
2. 给 `citationService` 增结构化 WebSearch citation 写入入口，保留旧 extractor。
3. WebSearch handler 生成 `WebSearchStructuredResultV1`，markdown `output` 不删除。
4. renderer summarizer 和 citation UI 先读 structured result，缺失时回退 markdown。
5. history sanitizer 覆盖 structured snippets、extractions、trace，并加长度上限测试。
6. 用阶段一 eval 基线复测：成功 query citation 非零、prompt injection sanitizer 命中、misleading SEO primary evidence 排名前置、provider failure 进入 `failures`。

## 验收

- `npm run typecheck` 通过。
- WebSearch targeted vitest 覆盖 structured payload、citation id 稳定性、legacy markdown fallback、renderer summary fallback。
- `tests/eval/webSearchP0Baseline.test.ts` 继续通过，并新增结构化 payload smoke。
- 对抗自审重点检查：无 raw key、无未截断正文、citation id 一致、legacy session 可读、hosted trace 不改变 routing 优先级。

## 相关文档

- [Web search borrowing plan](../plans/2026-06-26-web-search-borrowing-plan.md)
- [ADR-002: 工具结果 Token 优化方案](002-tool-result-token-optimization.md)

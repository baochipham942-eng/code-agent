# ADR-026: 搜索源多选 + 优先级用户配置（设置页 IA 重构 · 方向 A 阶段 2）

- **状态**: 已采纳（2026-06-22，随设置页模型 IA 重构方向 A 拍板）
- **日期**: 2026-06-22
- **关联**: `docs/plans/2026-06-22-settings-model-ia-redesign.md`；ADR-027（生成模型配置）

## 背景

设置页 IA 重构方向 A 要在新「模型与能力」分组下提供「搜索」配置。调研发现：

- 搜索**早已是多源架构**：`src/main/tools/web/search/searchStrategies.ts` 的
  `SEARCH_SOURCES[]` 含 7 源（firecrawl/cloud/perplexity/openai/exa/tavily/brave），
  `routeSources()` 按查询特征智能选 2-3 源，`getAvailableSources()` 按 key 可用性过滤 + 按
  内置 `priority` 排序。
- key 走 `configService.getServiceApiKey()`，用户已能在「Service API Keys」配置。
- **真缺口**：用户无任何可见入口去**启停某个源**或**调整优先级**——源选择全靠
  `routeSources` 的硬编码启发式 + 固定 `priority`。

即"林晨说的没暴露搜索 provider"实为"源管理面板缺失"，而非"没有 provider"。

> 注：`modelRouter.ts:226` 的 `search: { perplexity / sonar-pro }` 是**另一回事**——
> 主模型缺搜索能力时的推理降级（`inference.ts:547` 消费），不是 web search 工具的源选择。
> 本 ADR 不动它，留作后续单独评估。

## 决策

### D1 — 配置落点：新增 `AppSettings.search` 顶层字段（非 `models.routing.search`）

源选择是**搜索工具**层的配置，不是模型路由。放 `models.routing` 会语义错位。

```ts
// AppSettings
search?: {
  /** 用户禁用的搜索源 id（从可用源中排除） */
  disabledSources?: string[];
  /** 源优先级覆盖（id 顺序，越靠前越优先；未列出的按内置 priority 排在后） */
  sourceOrder?: string[];
};
```

- 全部可选，**未配置 = 现状行为不变**（向后兼容，无迁移）。
- 不在此存 key（key 仍由 secureStorage / configService 管，避免明文）。

### D2 — 消费点：单闸口 `getAvailableSources()` 注入用户偏好

`getAvailableSources(configService, requestedSources?, prefs?)` 增加第三参 `prefs`：
- 过滤掉 `disabledSources`；
- 按 `sourceOrder` 重排（列出的在前按其顺序，未列出的随后按内置 priority）。

`webSearch.ts` 调用处传入 `configService.getSettings().search`。因 `routeSources` 的启发式
结果在 `webSearch.ts:194` 与 `allAvailable` 取交集，禁用源经此单闸口即被剔除，优先级顺序
也由 `allAvailable` 的新排序带下去——**无需改 routeSources**。

### D3 — UI 数据通路：复用现有 IPC，零新增 handler

`SearchSettings` 面板用现成的 `IPC_DOMAINS.SETTINGS` 三 action：
- `get` → 完整 AppSettings → 读 `.search` 偏好；
- `getAllServiceKeys` → 判定哪些 premium 源已配 key；
- `set { settings: { search } }` → 保存（每次发完整 `search` 对象，规避 merge 深度问题）。

源的展示元数据（label / 描述 / 是否需 key / 是否付费）抽成 shared 常量
`SEARCH_SOURCE_CATALOG`（`src/shared/constants/providers.ts`），main 的 `SEARCH_SOURCES`
与 renderer 的面板共用同一组 id，避免漂移。

## 一致性 / 安全

- 禁硬编码规范：端点已在 `SEARCH_API_ENDPOINTS`；新增源元数据进 `SEARCH_SOURCE_CATALOG` 单一真源。
- 付费提示：premium 源（perplexity/openai/exa/tavily/brave）在 UI 标注「付费」。
- 向后兼容：`search` 全可选，老配置零迁移。

## 后果

- 用户获得"启停源 + 调优先级"的真实控制；默认行为不变。
- 代价：AppSettings 多一个可选顶层字段 + getAvailableSources 多一个可选参数。
- 不解决：`routeSources` 启发式本身的可调（如自定义"中文查询用哪些源"）——属后续增量。

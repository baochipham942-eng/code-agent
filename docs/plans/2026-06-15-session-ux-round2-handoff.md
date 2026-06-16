# 会话区 UX 第二轮排查 — 交接文档（给新会话）

> 来源：2026-06-15 dogfood 第二轮，用户在「空状态 + trace + 模型菜单 + 侧栏」又挑出 11 个问题。
> 第一轮（trace A–E + 空状态 15 点 + 侧栏简化）已在分支 `ui/session-declutter` 落地并验证生效。
> 本文是第二轮 backlog，新会话据此逐条排查。动手前核对行号未漂移、先 `npm run build`（含 renderer！）再验。

## 第二轮落地状态（2026-06-16，本轮已改）

全部 A–E 11 条已落地，`npm run typecheck` + `npm run build`（含 renderer）均通过；新增/更新单测通过（仅 `skillsInstalled.categoryGroup` 一条预存在的、与本轮无关的分类计数漂移失败）。决策点已与用户确认：A=跳过耗尽源+Tavily key 池；C-6=默认开+移入 InputAddMenu 二级菜单；D-11=砍掉空白入口、纯 chat 不继承当默认。

- **A-1**：`searchUtils.ts` 把 401/432 纳入 quota/auth 模式（长冷却）；`modules/network/webSearch.ts` 路由按 circuit-breaker 状态降级 + backfill 健康源；`searchStrategies.ts` 把 tavily 单 key 升级为 10-key 轮换池（命中 401/402/432/quota 自动切下一个，全耗尽才 trip 外层断路器）；10 个 key 写入 `~/.code-agent/.env` 与项目 `.env` 的 `TAVILY_API_KEYS`。
- **B-2**：`modelDecision.ts` 默认模型（xiaomi/mimo-v2.5-pro）标 `default-model` 而非 `user-selected`；`RouteTraceChip.tsx` 新增 `shouldRenderModelDecisionChip`——默认模型/纯直连且无路由变化/降级/外部引擎异常时整条 chip 不显（`TraceNodeRenderer.tsx` 接线）。
- **C-4**：`InlineWorkbenchBar.tsx` Auto 态且无手动选择时能力汇总行整条不显（`showCapabilitySummary`）。
- **C-5**：`AgentChip.tsx` 默认 agent `return null`。
- **C-6**：记忆开关默认开 + 从底栏移入 `InputAddMenu.tsx` 二级菜单（`ChatInput/index.tsx` 移除 Brain 按钮、传 props）。
- **C-7**：`ModelSwitcher.tsx` provider 头只留名称 + 健康色点，检测/计费/来源/协议/endpoint 收进 hover tooltip。
- **D-8**：未分类组关闭 force-expand（`sidebarGroupExpansion.ts` 新增 `disableForceExpand`），可正常折叠/展开。
- **D-9**：`Sidebar.tsx` 非管理员不再渲染行内 Replay(Eye) 按钮（之前是 disabled 仍可见）。
- **D-10**：状态筛选 tab 对非管理员整排隐藏，只留搜索框。
- **D-11**：顶部「新会话」改为纯对话不继承上下文；独立「空白」入口已下线；项目上下文会话走各项目组 + 按钮。
- **E-3**：`App.tsx` 右栏 TaskPanel 自动展开只看真实内容信号（待办/任务/待确认/后台/swarm/workflow），不再因 thinking/processing 瞬时态展开 → 默认收起、有内容才展开。
  - ⚠️ E-3 无法在静态环境复现确切的"未开始却展开"现象（switchSession 会清 todos，空会话各信号应为 false）；本轮按交接文档的目标语义（默认收起 + 内容驱动展开）改在最可控的 seam（`hasTaskWorkbenchContent`）。**请 dogfood 实测确认**：空/未开始会话右栏收起、产生任务/产物后展开、会话结束后行为符合预期。

---

## 已验证生效（上一轮，勿重复改）
搜索失败现在是「已恢复」徽标 + 一行「联网搜索额度不足…」+「去设置换 key」按钮 + 「查看原始报错」折叠；无满屏红 JSON、无「暂停恢复」。状态语义、侧栏 hint 精简、底栏「思考·低」均生效。

---

## A. 搜索路由（后端逻辑，最实质）

### 1. 没额度了为什么每次都先撞 perplexity/exa，而不是走还有额度的源？
- **根因**：`src/main/tools/web/search/searchStrategies.ts` 搜索源是**硬编码优先级**（supabase=1 / perplexity=2 / openai=3 / exa=4 / tavily=5 / brave=6），且 `isAvailable` **只判断 key 是否存在，不看额度**（:118/124/130/136…）。所以每轮都从 perplexity 开始撞，撞到 tavily 已经靠后。
- **澄清**：代码里 **tavily 是单 key，没有"池"**（`searchStrategies.ts:615` 单 key 解析）。用户以为的"tavily 池"不存在。
- **方向**：① 记住最近返回 401/402/432/quota 的源，短期（如本会话/N 分钟）跳过，不再每轮重撞；② 或把"近期成功率/额度状态"纳入排序，让还能用的源优先；③ 若真要 key 池/轮换，是另一个 feature。
- **决策点**：要不要做 key 池？还是先做"跳过已耗尽源"（更轻、收益大）。

---

## B. 路由决策展示

### 2. 为什么反复说「用户选择 mimo」，但用户并没选？
两个子问题：
- **(a) 标签语义错**：reason 标成 `user-selected`（'用户选择'），但 MiMo 是**默认模型**，用户根本没手动选。需查 `src/main/model/modelDecision.ts` / `src/main/services/agentEngine/agentEngineModelDecision.ts` 里 reason 何时被判成 `user-selected`——默认模型不应算"用户选择"。标签表在 `RouteTraceChip.tsx` REASON_LABELS。
- **(b) 仍重复出现**：上一轮已修去重 key（`useTurnProjection.ts buildModelDecisionProjectionKey` 去掉了每轮变的遥测），但 image 2 里"用户选择 mimo"仍出现 2 次。需复核：是这两次 decision 的 key 真不同（中间夹了搜索失败导致某字段变），还是该 chip 根本不该在每个 assistant 文本节点重复。**倾向**：默认模型 + 无变化时，这条 chip 干脆不显（只有真正发生路由/降级才显）。

---

## C. composer 进一步精简（上一轮改了文案，这轮要更狠）

### 4. 「能力 · 自动匹配」这一行没必要展示
- 上一轮我把「Skills 0/131 · MCP 0/16」在 Auto 态改成「能力 · 自动匹配」，但用户要**直接隐藏整行**。
- **方向**：`InlineWorkbenchBar.tsx` 在 `turnCapabilityScopeMode === 'auto' && 无手动选择` 时整条 `return null`（只在 Manual 或已选能力时才显）。

### 5. Explorer agent 没必要展示
- 底栏 `AgentChip`（`ChatInput/AgentChip.tsx`）显示当前 agent「Explorer」。默认 agent 不该占位。
- **方向**：当 agent 是默认/未显式切换时 `return null`；只有用户 `/agent` 切过才显。

### 6. 右侧「本次会话记忆开启/关闭」作用是？为什么不默认开就好？
- 底栏 Brain 按钮（`ChatInput/index.tsx:1747-1761`）= 本会话记忆开关。
- **决策点**：记忆默认就该开；这个 per-会话开关是给"敏感会话临时关记忆"用的低频功能。**方向**：默认开 + 把开关从底栏移走（进 InputAddMenu 二级菜单或设置），底栏不常驻。需确认产品是否要保留关记忆能力。

### 7. 模型菜单「未检测 / 按量 / 来源 / OpenAI-compatible · api.」太乱，只显重点
- `src/renderer/components/StatusBar/ModelSwitcher.tsx` 模型菜单每个 provider/模型行堆了：检测状态(未检测)、计费(按量)、来源(UltraSpeed)、协议(OpenAI-compatible)、endpoint 等。
- **方向**：菜单只留「模型名 + 能力图标（工具/视觉/思考）」；检测状态/计费/来源/协议这些工程内幕收进 hover tooltip 或二级"详情"。这是模型菜单的信息架构重做。

---

## D. 侧栏进一步精简 + 权限

### 8. 左侧「未分类」那个组没法展开/收起
- `Sidebar.tsx` 项目组有 `expandedWorkspaces` 折叠态（:276/1830/1868 chevron rotate），但「未分类」组（`isUncategorized`）多处被特判（:554 `.filter(g => !g.isUncategorized)`）。需查未分类组的折叠 toggle 是否被禁用/未接线。
- **方向**：让未分类组也能正常折叠/展开。

### 9. 会话 Replay 不该给普通用户看到
- `Sidebar.tsx:1514-1531` 的 Eye(Replay) 按钮已有 `canOpenSessionReplay`（管理员）门控——但**非管理员仍能看到这个 disabled 按钮**。
- **方向**：非管理员**直接不渲染** Replay 按钮（而非 disabled）。

### 10. 会话状态筛选不需要，普通用户能搜索就行
- `Sidebar.tsx:132` `SESSION_STATUS_FILTER_OPTIONS`（全部/未完成/待确认/执行中/需关注/交付线索/待审）。
- **方向**：对普通用户隐藏整排状态筛选 tab，只留搜索框；筛选 tab 仅管理员或收进二级菜单。

### 11. 「新建空白会话」有必要吗？纯 chat 不继承项目上下文当默认就好
- 现在有「新会话」（继承项目上下文）+「空白」（不继承）两个入口，加空状态右上「空白会话」状态标。
- **决策点**：是否把"纯 chat 不继承上下文"做成默认行为，砍掉「空白」这个独立入口。需产品确认两种新建语义是否都要保留。

---

## E. 布局行为

### 3. 未开始会话时右侧栏（任务信息/TaskPanel）展示了，会话结束反而收起——应按需展开
- 右侧 TaskPanel 的自动展开/收起逻辑没在 `ChatView.tsx` 直接找到，需定位（疑在 appStore / TaskPanel 自身 / workbench 状态）。
- **现象**：空状态/未开始 → 右栏展开（没内容却占地）；会话跑完 → 收起。逻辑反了。
- **方向**：默认收起，**有任务/产物时才按需展开**（或用户手动开）。

---

## 优先级建议（新会话参考）
1. **B-2（用户选择 mimo 误标 + 重复）** + **A-1（搜索跳过已耗尽源）**：最影响"看起来不智能"，且是真逻辑问题。
2. **C-4/5/7 + D-9/10**：纯精简/权限，低风险高可见（隐藏能力行、Explorer chip、Replay 按钮、筛选 tab；模型菜单瘦身）。
3. **E-3（右栏按需展开）**：行为修正。
4. **C-6 记忆默认开 / D-11 空白会话 / D-8 未分类折叠**：含产品决策，先与用户确认语义再动。

> 决策点（需用户拍板，别擅自删功能）：A-1 是否做 key 池；C-6 是否保留关记忆能力；D-11 是否砍掉独立"空白会话"入口。
> 工程注意：改完是 renderer 改动为主，验证务必 `rm -rf ~/.code-agent/renderer-cache/active && npm run build`（不是 build:web）再 `cargo tauri dev`。

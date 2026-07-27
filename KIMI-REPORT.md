# KIMI-REPORT — 连接器（MCP）页降噪批

启动提示词：`docs/plans/2026-07-27-连接器页降噪-启动提示词.md`（private-archive）
Worktree：`.worktrees/mcp-connectors-polish`，分支 `feat/mcp-connectors-polish`（基于 origin/main，未 push）

## 改动清单

### 1. undefined 修根（不再有任何裸 undefined/null 字符串能进 UI）

- `src/renderer/utils/workbenchPresentation.ts`
  - `getMcpTrustSummary` 上移到此处并改为防御式拼接：transport 缺失整段省略；计数只在 `connected` 且为有限数字时拼接；审批/凭证提示兜底为 i18n 常量。
  - `getWorkbenchCapabilityTitle` / `getWorkbenchReferenceTitle`：`transport: ${...}` 仅在 transport 已知时输出。
- `src/renderer/utils/workbenchCapabilityRegistry.ts`：assessment tags 中 tool/resource 计数仅在 `Number.isFinite` 时输出。
- `src/renderer/components/workbench/WorkbenchCapabilitySheetLite.tsx`（详情弹层）：transport 行仅在已知时渲染；tools/resources 行仅在 connected 且有有限计数时渲染；新增每台 server 的 trust summary 行（安全事实在详情层仍可查）。

### 2. 安保样板上移页面级

- `MCPSettings.tsx`：行内不再重复「destructive/openWorld 调用前仍需审批 · 凭证默认 masked…」；改为列表标题（服务器配置）下方一行页面级说明（`data-testid="mcp-trust-summary-note"`）。每台 server 真实的授权差异（需重新授权提示）仍留在错误列。

### 3. 计数只在真加载后显示

- 列表行「工具 / 资源」列：`connectionState === 'connected'` 且计数为有限数字才显示真实计数，否则显示 `—`；未连接/懒加载未触发不再出现误导性的「0 工具 / 0 资源」。详情弹层同样处理。

### 4. 行布局统一 + 操作收纳

- 行尾操作全列表统一为：**Toggle 开关（启用/禁用，用 `primitives/Toggle`，遵守 switch 收敛棘轮）+ 详情（info）入口**。
- 「重连」「重新授权」「退出授权」从行上移除，收纳进详情弹层 quick actions：
  - `src/renderer/utils/workbenchQuickActions.ts`：新增 `sign_out_mcp` 动作类型；MCP 在 sheet（`includeUnselected`）场景下由 `buildMcpQuickActions` 自行决定暴露哪些动作（connected 的 OAuth server 也能透出「退出授权」）；新增执行路由与完成后反馈文案。
  - `src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner.ts`：新增 `signOutMcpServer` handler（走既有 `signOutServer` IPC）。
- 协议列徽标仅在 transport 已知时渲染。

### 5. 信息不删只收纳

- destructive/openWorld 审批、凭证 mask 事实：页面级一行 + 详情弹层 trust summary 均可见；OAuth 授权状态仍显示在对应行。

### 6. i18n / 依赖 / host

- 未新增 i18n key（复用现有 `trustSummary.*`、`management.*`），zh/en 天然同步；未新增依赖；未改 `src/host`。

### 7. 测试

- `tests/renderer/components/mcpSettings.status.test.ts`：
  - 新增：trust summary 空值省略（无 undefined/未加载无计数段）、transport 未知时行内无裸 undefined、样板文案全页只出现一次、未连接不显示计数且重连收进详情、行尾开关调用 `setServerEnabled`、sheet 退出授权动作路由到 quick-action runner。
  - 改写：重授权/重连/OAuth sign-out 的行内断言改为「行上没有 + 详情层 quick actions 有」。
- `tests/renderer/utils/workbenchQuickActions.test.ts`：
  - 新增：未选中 server 在 sheet 暴露重连（行内不暴露）、未选中 auth 失败路由到重新授权、OAuth server 暴露退出授权（无 token 不暴露）、`sign_out_mcp` 执行路由 + 状态刷新 + 反馈文案。
- 既有 `settingsToggleConvergence` 棘轮遵守：开关使用 `primitives/Toggle`，未新增手搓 `role="switch"`。

## 验收门

- `npm run typecheck`：通过（0 error）。
- `npm run lint`：0 error（425 warning 均为存量，与本次改动文件无关；改动文件 eslint 零告警）。
- `npx vitest run tests/renderer`：506 文件 / 3221 测试全绿。

## Commits

- `578ff48d8` 连接器页降噪 1/2：MCP 摘要/计数拼接防御空值，安全事实收进详情弹层
- `499906f59` 连接器页降噪 2/2：行布局统一为开关+详情，重连/退出授权收纳进详情层

未 push（按启动提示词要求）。

---

# 默认态与工具条合并批（2026-07-27）

启动提示词：`docs/plans/2026-07-27-能力中心默认态与专家工具条合并-启动提示词.md`（private-archive）
同一 worktree / 分支追加，未 push。

## 改动清单

### 1. 隐藏「插件」tab（代码保留，只下架入口）

- `src/renderer/components/features/capabilityHub/CapabilityHubPage.tsx`：`visibleTabs` 无条件过滤掉 `plugins`（原逻辑是按 `canAccessSettingsTab` 门控；现该映射本就为空，等于人人可见）。`HUB_TABS` 常量、深链映射（`settingsTabs.ts` 的 `plugins: 'plugins'`）、`PluginsSettings` 懒加载与内容分支全部保留。
- 深链兜底：现有「tab 不可见时回退第一个可见 tab」的 `useEffect` 原样兜住 `openCapabilityHub('plugins')` —— 回退到 `experts`，不崩不白屏（有测试锁死）。

### 2. 默认落「发现」

- `ExpertPanel.tsx`：tab state 初始值 `'mine'` → `'discover'`（新用户「我的」是空的，先给推荐视角）。
- `MCPSettings.tsx`（连接器）：存在「已连接 / 发现连接」分段控件，初始值 `'connected'` → `'discover'`。深链聚焦（`settingsCapabilityFocus` 为 mcp/connector）仍强制切回「已连接」，不受影响。
- 技能页默认 tab 未动（另一分支处理，`SkillsSettings.tsx` 零改动）。

### 3. 专家页工具条与分类合一行

- `ExpertPanel.tsx`：分类 chips 从独立行合并进 sticky 工具条——左侧 = chips（`flex-wrap`，多了自然换到第二行），右侧 = 我的/发现分段 + 刷新 + 新建专家（`ml-auto` 贴右）。
- chips 显示条件不变（`!loading && categoryGroups.length > 0`）；chips 不显示时左侧自然塌陷，右侧靠 `ml-auto` 保持右对齐，未造占位元素。
- sticky 定位、`bg-zinc-900/90` + `border-b border-zinc-800/70` + `backdrop-blur` 原样保留。

### 4. i18n / host

- 未增删 i18n key；未改 `src/host`；未改 `SkillsSettings.tsx`。

## 测试

- `capabilityHubPage.test.tsx`：四 tab 断言改为三 tab + 插件 tab 不渲染；新增「plugins 深链回退到第一个可见 tab」。
- `ExpertPanel.test.tsx`：默认 tab 断言改为 discover；「我的」空态、分类 chips 两条用例先显式切回 mine；chips 用例新增「chips 与操作按钮同处一条 sticky 工具条」断言。其余用例（刷新/新建/筛选/装包同意卡等）原断言不动保持绿。
- `mcpSettings.status.test.ts`：新增 `openConnectedTab()` 助手（startsWith 匹配「已连接 (N)」）；默认落发现的断言改为「发现目录在屏、已连接表格不渲染」；原 `renderToStaticMarkup` 静态断言全部改为 render + 切「已连接」后取 `document.body.innerHTML`（避免默认发现下的假绿）。

## 验收门

- `npm run typecheck`：通过（0 error）。
- `npm run lint`：0 error（425 warning 均为存量，与上一批相同，与本次改动文件无关）。
- 相关测试：`capabilityHubPage` + `ExpertPanel` + `mcpSettings.status` + `capabilityCenterDefaults` 4 文件 54 测试全绿。
- 全量 `npx vitest run tests/renderer`：506 文件 / 3222 测试全绿。

## Commits

- 本批改动以单 commit 追加在 `feat/mcp-connectors-polish` 顶端（message：能力中心默认态与专家工具条合并……），HEAD sha 以 `git rev-parse HEAD` 为准。

未 push（按启动提示词要求）。

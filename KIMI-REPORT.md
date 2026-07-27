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

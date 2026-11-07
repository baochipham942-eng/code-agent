// ============================================================================
// CUA 能力阶梯工具描述后缀（N-CUA-SCREEN-GUARDS-LADDER）
// ============================================================================
// 阶梯语义：connectors / 原生工具（mail、calendar、reminders、MCP、files、
// shell）→ browser_action（网页）→ 屏幕控制（最后手段，动手前先说一句话）。
// 完整规则在 TOOLS_PROMPT（src/host/prompts/base/tools.ts），常驻不依赖 cua
// 安装态；这里只放挂在 cua 工具描述上的短后缀，两个出口共用同一常量防漂移：
//   1) mcpToolRegistry.getToolDefinitions() —— raw cua-driver 三个入口工具
//   2) cuaStatefulComputerUse.schema —— V2 computer_use 描述
// 改动时保持 ≤ 35 words（token 成本约束）。

/** cua 入口工具描述统一追加的阶梯后缀（32 words）。 */
export const CUA_SCREEN_LADDER_TOOL_SUFFIX =
  'Last resort: prefer connectors, files, shell, or browser_action when they can do the job; before the first screen action, tell the user in one sentence why you are driving this app directly.';

/** 只给三个入口工具挂后缀（launch_app / get_window_state / click），控制 token 成本。 */
export const CUA_SCREEN_LADDER_ENTRY_TOOLS: ReadonlySet<string> = new Set([
  'launch_app',
  'get_window_state',
  'click',
]);

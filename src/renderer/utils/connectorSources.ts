// ============================================================================
// connectorSources —— 底栏连接器图标的「来源三态」解析
// ============================================================================
// 用户看着底栏那排图标最常问「这是啥、谁放的、为什么在」。这里只回答「专家带的」
// 那一支：专家 agent.md 声明的 core 连接器，每一轮在背后生效却从不露面。
//
// 生效口径不在这里定义——照抄宿主 withWorkbenchTurnSystemContext 用的同一个
// resolveSessionConnectorIds（会话选过 → 以会话为准；没选过才落到专家 core）。
// UI 只负责把它算出来的结果说成人话，不另立第二套规则。
// ============================================================================

import { resolveSessionConnectorIds, type ExpertConnector } from '@shared/contract/expertConnectors';

/**
 * connected = 这个连接器自己连上了，它的工具就在本轮工具表里；
 * disconnected = 声明了但没连上 / 压根没装；hub_off = 在能力中心里被关掉了。
 *
 * 🔴 别把 connected 读成「专家的 core 声明这一轮生效了」——那是两件事。connected 只说
 * 「这个连接器自己连上了、它的工具在本轮工具表里」；至于专家声明有没有把工具面**收窄**
 * 到这几个，由宿主 `withWorkbenchTurnSystemContext` 按类型分流后决定（连接器那支进
 * allowedConnectorIds、MCP 那支进 allowedMcpServerIds，各自过一次「连上了没」，
 * 都没连上就不收窄）。渲染层拿不到最终 scope，所以这里不替它宣称「生效」。
 */
export type ExpertConnectorStatus = 'connected' | 'disconnected' | 'hub_off';

export interface ExpertConnectorSourceItem {
  id: string;
  /** 去能力中心时跳哪一类；没装过的按 mcp 走——专家声明的 id 空间对齐 mcpCatalog */
  kind: 'connector' | 'mcp';
  label: string;
  reason?: string;
  status: ExpertConnectorStatus;
}

export interface ExpertConnectorSource {
  items: ExpertConnectorSourceItem[];
  /**
   * 用户在本会话手选过连接器、把专家那支整支挤掉了（宿主 explicit > 专家 的同款判定）。
   *
   * 只表达「谁的选择说了算」，**不表达「这些工具真进了本轮工具面」**——后者由宿主
   * 的 `isConnectorReadyForTurnScope`（workbenchTurnContext.ts:422）说了算，它要求
   * id 在 connector registry 里存在，而专家声明的 id 空间是连接器目录（lark 这类 MCP
   * 名）⇒ MCP 类 core 在宿主侧会被整批过滤掉。那是上游的病（N-EXPERT-CORE-MCPSCOPE），
   * 渲染层拿不到最终 scope，所以这里也不许替它宣称「生效」。
   */
  sessionOverridden: boolean;
  /** 有一条不是「已连接」就够了：组合图标右上角挂警示点 */
  hasIssue: boolean;
}

export function buildExpertConnectorSource(args: {
  expertConnectors?: readonly ExpertConnector[];
  sessionSelectedIds: readonly string[];
  installed: ReadonlyMap<string, { kind: 'connector' | 'mcp'; connected: boolean; enabled: boolean }>;
  resolveLabel: (id: string) => string;
}): ExpertConnectorSource | null {
  const coreIds = resolveSessionConnectorIds({ expertConnectors: args.expertConnectors });
  if (coreIds.length === 0) return null;

  const byId = new Map((args.expertConnectors || []).map((connector) => [connector.id, connector]));
  const items = coreIds.map<ExpertConnectorSourceItem>((id) => {
    const state = args.installed.get(id);
    const status: ExpertConnectorStatus = !state
      ? 'disconnected'
      : !state.enabled
        ? 'hub_off'
        : state.connected ? 'connected' : 'disconnected';
    const reason = byId.get(id)?.reason;
    return { id, kind: state?.kind ?? 'mcp', label: args.resolveLabel(id), ...(reason ? { reason } : {}), status };
  });

  const resolved = resolveSessionConnectorIds({
    sessionSelectedIds: args.sessionSelectedIds,
    expertConnectors: args.expertConnectors,
  });
  const sessionOverridden = !coreIds.every((id) => resolved.includes(id));

  return {
    items,
    sessionOverridden,
    hasIssue: items.some((item) => item.status !== 'connected'),
  };
}

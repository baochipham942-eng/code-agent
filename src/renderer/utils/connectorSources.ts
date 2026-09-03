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

/** connected=这轮真能调；disconnected=声明了但没连上/没装；hub_off=能力中心里被关了 */
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
   * 这一轮专家那支是不是真生效。用户在本会话手选过连接器时整支让位（宿主同款判定），
   * 图标照露——不露用户就永远不知道专家在用什么——但卡上要说清「这轮以你的选择为准」。
   */
  effective: boolean;
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
  const effective = coreIds.every((id) => resolved.includes(id));

  return {
    items,
    effective,
    hasIssue: items.some((item) => item.status !== 'connected'),
  };
}

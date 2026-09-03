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
import { CONNECTOR_TOOL_NAMES } from '@shared/contract/workbenchTools';
import { NATIVE_CONNECTOR_IDS } from '@shared/constants/misc';

/**
 * connected = 这个连接器自己连上了，它的工具就在本轮工具表里；
 * lazy = 装好了、enabled，stdio 默认 lazyLoad 停在待连状态，第一次用到时自动连——
 *        这是健康配置，不是故障：不挂警示点、不给「去连接」出口；
 * disconnected = 声明了但没连上 / 压根没装 / 连接出错；hub_off = 在能力中心里被关掉了。
 *
 * 🔴 别把 connected 读成「专家的 core 声明这一轮生效了」——那是两件事。connected 只说
 * 「这个连接器自己连上了、它的工具在本轮工具表里」；至于专家声明有没有把工具面**收窄**
 * 到这几个，由宿主 `withWorkbenchTurnSystemContext` 按类型分流后决定（连接器那支进
 * allowedConnectorIds、MCP 那支进 allowedMcpServerIds，各自过一次「可用了没」，
 * 都不可用就不收窄）。渲染层拿不到最终 scope，所以这里不替它宣称「生效」。
 */
export type ExpertConnectorStatus = 'connected' | 'lazy' | 'disconnected' | 'hub_off';

/** 已装那条记录带给三态解析的最小事实；status 对齐宿主 MCPServerStatus */
export interface ExpertConnectorInstalledState {
  kind: 'connector' | 'mcp';
  status: 'connected' | 'lazy' | 'connecting' | 'disconnected' | 'error';
  enabled: boolean;
}

export interface ExpertConnectorSourceItem {
  id: string;
  /** 去能力中心时跳哪一类；连接器侧 id（CLI + 原生）在 CONNECTOR_TOOL_NAMES 里有键，没装过也能归侧，其余按 mcp——专家声明的 id 空间对齐 mcpCatalog */
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
   * `withWorkbenchTurnSystemContext` 按类型分流 + 可用性过滤后决定，渲染层拿不到
   * 最终 scope，所以这里也不许替它宣称「生效」。
   */
  sessionOverridden: boolean;
  /** 有一条出了状况就够了：组合图标右上角挂警示点（lazy 是健康态，不算） */
  hasIssue: boolean;
}

export function buildExpertConnectorSource(args: {
  expertConnectors?: readonly ExpertConnector[];
  sessionSelectedIds: readonly string[];
  installed: ReadonlyMap<string, ExpertConnectorInstalledState>;
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
        : state.status === 'connected'
          ? 'connected'
          : state.status === 'lazy' || state.status === 'connecting'
            ? 'lazy'
            : 'disconnected';
    const reason = byId.get(id)?.reason;
    // installed 里查不到时按 id 本身归侧：连接器侧的 id = CONNECTOR_TOOL_NAMES 的键
    //（CLI + 有工具的原生）∪ NATIVE_CONNECTOR_IDS（含没工具的 photos）——与宿主
    // isConnectorSideId 同一套认知。没连上只是不在过滤后的注册表列表里，跳 MCP 侧会
    // 标错类、定位不到。用 Object.hasOwn——`in` 走原型链，toString/constructor 这类 id 会被误归侧
    const isConnectorSide = Object.hasOwn(CONNECTOR_TOOL_NAMES, id)
      || (NATIVE_CONNECTOR_IDS as readonly string[]).includes(id);
    const kind = state?.kind ?? (isConnectorSide ? 'connector' : 'mcp');
    return { id, kind, label: args.resolveLabel(id), ...(reason ? { reason } : {}), status };
  });

  const resolved = resolveSessionConnectorIds({
    sessionSelectedIds: args.sessionSelectedIds,
    expertConnectors: args.expertConnectors,
  });
  const sessionOverridden = !coreIds.every((id) => resolved.includes(id));

  return {
    items,
    sessionOverridden,
    hasIssue: items.some((item) => item.status !== 'connected' && item.status !== 'lazy'),
  };
}

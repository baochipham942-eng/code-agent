// ============================================================================
// MountedConnectorIcons - 底栏「当前会话挂载的连接器 / MCP」chip 行
// ============================================================================
// 入口级可视：用户挂上飞书等连接器后，底栏权限徽章旁边直接看得到「这轮带着谁」。
// 会话级挂载只在这里出现（不进文字区 chip，那是单轮语义）；名称必须常驻可见，
// 不能只靠 tooltip，否则从连接器卡「去使用」跳回聊天后看不出挂载结果。
// 图标按类型区分：connector 用 Plug、MCP server 用 Server。
//
// 2026-09-03（N-CONNECTOR-INCHAT）：每颗 chip 悬停出一张来源卡，回答「这是啥、谁放的、
// 为什么在」。专家 agent.md 声明的 core 连接器每一轮在背后生效却从不露面，这里合成
// 一颗「专家徽标 + 数字」的组合 chip 露出来（灰一档、不可移除，要关去能力中心——
// 一个能力只有一个家）。用户手选的仍逐颗显示，超 4 颗折 +N（同技能胶囊规则）。
// 手选与专家两支都空时不渲染，不占底栏格子。
// ============================================================================

import React, { useCallback, useMemo, useState } from 'react';
import { AlertCircle, Plug, Server, X } from 'lucide-react';
import { CLI_CONNECTOR_DESCRIPTORS } from '@shared/constants/cliConnectorDescriptors';
import { findRecommendedMcpServer } from '@shared/constants/mcpCatalog';
import { useWorkbenchCapabilityRegistry } from '../../../../hooks/useWorkbenchCapabilityRegistry';
import { useConnectorOAuthStatuses } from '../../../../hooks/useConnectorOAuthStatuses';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppStore } from '../../../../stores/appStore';
import { useComposerStore } from '../../../../stores/composerStore';
import { useAgentRegistryStore } from '../../../../stores/agentRegistryStore';
import {
  buildExpertConnectorSource,
  type ExpertConnectorInstalledState,
  type ExpertConnectorSourceItem,
  type ExpertConnectorStatus,
} from '../../../../utils/connectorSources';
import { removeCapability } from './SelectedCapabilityChips';
import { ConnectorLogo } from '../../connectors/ConnectorLogo';
import { RoleIcon } from '../../shared/RoleIcon';
import { CapabilitySourceHover } from './CapabilitySourceHover';

/** 和框内技能胶囊同一条溢出规则，只是底栏更窄所以上限更小 */
const MAX_VISIBLE_MANUAL = 4;

const STATUS_DOT: Record<ExpertConnectorStatus, string> = {
  connected: 'bg-badge-success',
  lazy: 'bg-badge-info',
  disconnected: 'bg-zinc-500',
  hub_off: 'bg-badge-danger',
};

export const MountedConnectorIcons: React.FC = () => {
  const { t } = useI18n();
  const text = t.chatInput.connectorSource;
  const hubText = t.expert.roleSkills;
  // MCP 状态看注册表的 mcpServers——它是**全量**（withMissingMcpServers 补齐了没进
  // 「已连接 ∪ 手选」的 server，带 status + enabled），lazy 待连 / 被关掉的都在里面。
  // CLI / SaaS 连接器（feishu/tmeet）的登录态不在连接器注册表，要走另一条
  // oauthStatus 通道——只看注册表会把连好的飞书恒判成「未连接」（与宿主
  // isConnectorReadyForTurnScope 读的 cliConnectorStatusCache 直接打架）。
  const { connectors, mcpServers } = useWorkbenchCapabilityRegistry();
  const activeAgentId = useAppStore((state) => state.activeAgentId);
  const openCapabilitySettingsTarget = useAppStore((state) => state.openCapabilitySettingsTarget);
  const agentEntries = useAgentRegistryStore((state) => state.entries);
  const selectedConnectorIds = useComposerStore((state) => state.selectedConnectorIds);
  const selectedMcpServerIds = useComposerStore((state) => state.selectedMcpServerIds);
  const oauthStatuses = useConnectorOAuthStatuses([...selectedConnectorIds].sort().join(','));
  const oauthConnectedById = new Map(
    oauthStatuses.map((status) => [status.id, status.connected && status.stale !== true]),
  );

  // 同一个 id 在底栏两处出现时必须同名：CLI 连接器走 SaaS 词表，其余走连接器目录，都查不到退回 id
  const connectorDisplayName = useCallback(
    (id: string): string =>
      (id === 'feishu' || id === 'tmeet')
        ? t.settings.saasConnectors.providers[id]
        : findRecommendedMcpServer(id)?.name || id,
    [t],
  );

  const manual = [...connectors, ...mcpServers].filter((capability) => capability.selected);
  const expert = agentEntries.find((entry) => entry.id === activeAgentId);
  // 折进 +N 的连接器不能丢 × 移除入口——+N 做成可展开/收起的开关
  const [manualExpanded, setManualExpanded] = useState(false);

  const expertSource = useMemo(() => {
    const installed = new Map<string, ExpertConnectorInstalledState>();
    for (const server of mcpServers) {
      installed.set(server.id, {
        kind: 'mcp',
        status: server.status,
        enabled: server.enabled !== false,
      });
    }
    for (const connector of connectors) {
      installed.set(connector.id, {
        kind: 'connector',
        status: connector.connected ? 'connected' : 'disconnected',
        enabled: true,
      });
    }
    // CLI / SaaS 那支注册表里没有，用 oauthStatus 的登录态覆盖（连好的飞书不能再判「未连接」）
    for (const status of oauthStatuses) {
      installed.set(status.id, {
        kind: 'connector',
        status: status.connected && status.stale !== true ? 'connected' : 'disconnected',
        enabled: true,
      });
    }
    return buildExpertConnectorSource({
      expertConnectors: expert?.connectors,
      // 让位判据与宿主同口径：会话在任一侧手选过，专家那支就整支让位
      sessionSelectedIds: [...selectedConnectorIds, ...selectedMcpServerIds],
      installed,
      resolveLabel: connectorDisplayName,
    });
  }, [connectors, mcpServers, oauthStatuses, expert?.connectors, selectedConnectorIds, selectedMcpServerIds, connectorDisplayName]);

  if (manual.length === 0 && !expertSource) return null;

  const visibleManual = manualExpanded ? manual : manual.slice(0, MAX_VISIBLE_MANUAL);
  const overflowCount = manual.length - Math.min(manual.length, MAX_VISIBLE_MANUAL);
  const expertName = expert?.name || expert?.id || '';

  const statusLine = (item: Pick<ExpertConnectorSourceItem, 'status'>) => (
    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-400">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[item.status]}`} aria-hidden />
      {item.status === 'connected'
        ? hubText.connectorConnected
        : item.status === 'lazy'
          ? text.connectorLazy
          : item.status === 'hub_off'
            ? text.hubOff
            : hubText.connectorMissing}
    </p>
  );

  const goToHub = (kind: 'connector' | 'mcp', id: string) => {
    openCapabilitySettingsTarget({ kind, id });
  };

  return (
    <div className="flex items-center gap-1" data-testid="mounted-connector-icons">
      {visibleManual.map((capability) => {
        const TypeIcon = capability.kind === 'mcp' ? Server : Plug;
        // 与专家卡同名的口径（上面 connectorDisplayName 注释）：MCP 那颗不能再用裸 serverId
        const label = capability.kind === 'mcp'
          ? connectorDisplayName(capability.id)
          : (capability.id === 'feishu' || capability.id === 'tmeet')
            ? t.settings.saasConnectors.providers[capability.id]
            : capability.label;
        const catalogEntry = capability.kind === 'mcp'
          ? findRecommendedMcpServer(capability.id)
          : undefined;
        const logo = capability.kind === 'mcp'
          ? catalogEntry?.logo
          : CLI_CONNECTOR_DESCRIPTORS.find((descriptor) => descriptor.id === capability.id)?.logo;
        // 手选状态与专家那颗同口径：MCP 查注册表全量项（先 hub_off——被关掉的 stdio
        // 恒 lazy，不看 enabled 会误写成「已装好」——再 lazy，都不误报「未连接」）；
        // CLI / SaaS 连接器看 oauthStatus 的登录态，原生连接器看注册表的 available
        const serverState = capability.kind === 'mcp'
          ? mcpServers.find((server) => server.id === capability.id)
          : undefined;
        const connectedNow = capability.kind === 'connector'
          ? (oauthConnectedById.get(capability.id) ?? capability.available)
          : capability.available;
        const manualStatus: ExpertConnectorStatus = serverState?.enabled === false
          ? 'hub_off'
          : connectedNow
            ? 'connected'
            : serverState && (serverState.status === 'lazy' || serverState.status === 'connecting')
              ? 'lazy'
              : 'disconnected';
        const needsHub = manualStatus === 'disconnected' || manualStatus === 'hub_off';
        return (
          <CapabilitySourceHover
            key={capability.key}
            testId={`mounted-capability-source-${capability.kind}-${capability.id}`}
            card={
              <>
                <p className="font-medium text-zinc-100">{label}</p>
                <p className="mt-1 text-[11px] text-zinc-400">{text.addedByYou}</p>
                {statusLine({ status: manualStatus })}
                {needsHub && (
                  <button /* ds-allow:button: 悬停卡里的紧凑出口，Button primitive 会把卡撑高 */
                    type="button"
                    onClick={() => goToHub(capability.kind === 'mcp' ? 'mcp' : 'connector', capability.id)}
                    className="mt-1.5 text-[11px] text-badge-accent hover:underline"
                  >
                    {manualStatus === 'hub_off' ? text.goHub : hubText.connectorGoConnect} →
                  </button>
                )}
              </>
            }
          >
            <div
              data-testid={`mounted-capability-${capability.kind}-${capability.id}`}
              className="group inline-flex h-[24px] max-w-[180px] shrink-0 items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/70 px-1.5 text-xs text-zinc-200 transition-colors hover:border-zinc-500"
            >
              <ConnectorLogo
                id={logo}
                displayName={catalogEntry?.name ?? label}
                fallback={<TypeIcon className="h-3 w-3 shrink-0 text-badge-info" aria-hidden />}
                className="h-3 w-3"
              />
              <span className="truncate">{label}</span>
              <button /* ds-allow:button: chip 内紧凑移除动作，Button primitive 无此尺寸 */
                type="button"
                onClick={() => removeCapability(capability)}
                aria-label={t.chatInput.connectorIconRemoveAria.replace('{name}', label)}
                className="-mr-0.5 shrink-0 rounded-full p-0.5 text-zinc-400 transition-colors hover:bg-zinc-600/70 hover:text-zinc-100"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          </CapabilitySourceHover>
        );
      })}

      {overflowCount > 0 && (
        <button /* ds-allow:button: 溢出折叠的展开开关，纯文本语义，Button primitive 无此尺寸 */
          type="button"
          data-testid="mounted-capability-overflow"
          onClick={() => setManualExpanded((expanded) => !expanded)}
          className="shrink-0 text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
          title={manualExpanded ? text.overflowCollapse : text.overflowMore.replace('{count}', String(overflowCount))}
          aria-label={manualExpanded ? text.overflowCollapse : text.overflowMore.replace('{count}', String(overflowCount))}
        >
          {manualExpanded ? '−' : `+${overflowCount}`}
        </button>
      )}

      {expertSource && (
        <CapabilitySourceHover
          testId="expert-connector-source"
          card={
            <>
              <p className="font-medium text-zinc-100">{text.expertGroupLabel.replace('{expert}', expertName)}</p>
              {expertSource.sessionOverridden && (
                <p className="mt-1 text-[11px] text-badge-warning">{text.expertOverridden}</p>
              )}
              <ul className="mt-1.5 space-y-2">
                {expertSource.items.map((item) => (
                  <li key={item.id}>
                    <p className="text-zinc-100">{item.label}</p>
                    <p className="mt-0.5 text-[11px] text-zinc-400">
                      {item.reason
                        ? text.expertNeedsReason.replace('{expert}', expertName).replace('{reason}', item.reason)
                        : text.expertNeeds.replace('{expert}', expertName)}
                    </p>
                    {statusLine(item)}
                    {(item.status === 'disconnected' || item.status === 'hub_off') && (
                      <button /* ds-allow:button: 悬停卡里的紧凑出口，Button primitive 会把卡撑高 */
                        type="button"
                        onClick={() => goToHub(item.kind, item.id)}
                        className="mt-1 text-[11px] text-badge-accent hover:underline"
                      >
                        {item.status === 'hub_off' ? text.goHub : hubText.connectorGoConnect} →
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          }
        >
          {/* 专家带的那颗：灰一档、无移除键——要关去能力中心，会话里只选不配 */}
          <div
            data-testid="expert-connector-badge"
            aria-label={text.expertGroupAria
              .replace('{expert}', expertName)
              .replace('{count}', String(expertSource.items.length))}
            className={`relative inline-flex h-[24px] shrink-0 items-center gap-1 rounded-full border border-zinc-700/70 bg-zinc-800/40 px-1.5 text-xs text-zinc-400 ${
              expertSource.sessionOverridden ? 'opacity-60' : ''
            }`}
          >
            <RoleIcon name={expert?.icon} className="h-3 w-3 shrink-0" />
            <span className="tabular-nums">{expertSource.items.length}</span>
            {expertSource.hasIssue && (
              <AlertCircle
                data-testid="expert-connector-badge-issue"
                className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 text-badge-warning"
                aria-hidden
              />
            )}
          </div>
        </CapabilitySourceHover>
      )}
    </div>
  );
};

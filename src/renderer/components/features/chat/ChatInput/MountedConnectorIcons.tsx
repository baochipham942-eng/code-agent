// ============================================================================
// MountedConnectorIcons - 底栏「当前会话挂载的连接器 / MCP」chip 行
// ============================================================================
// 入口级可视：用户挂上飞书等连接器后，底栏权限徽章旁边直接看得到「这轮带着谁」。
// 会话级挂载只在这里出现（不进文字区 chip，那是单轮语义）；名称必须常驻可见，
// 不能只靠 tooltip，否则从连接器卡「去使用」跳回聊天后看不出挂载结果。
// 图标按类型区分：connector 用 Plug、MCP server 用 Server。
// 无挂载时不渲染，不占底栏格子。

import React from 'react';
import { Plug, Server, X } from 'lucide-react';
import { useWorkbenchCapabilityRegistry } from '../../../../hooks/useWorkbenchCapabilityRegistry';
import { useI18n } from '../../../../hooks/useI18n';
import { removeCapability } from './SelectedCapabilityChips';

export const MountedConnectorIcons: React.FC = () => {
  const { t } = useI18n();
  const { connectors, mcpServers } = useWorkbenchCapabilityRegistry();
  const mounted = [...connectors, ...mcpServers].filter((capability) => capability.selected);
  if (mounted.length === 0) return null;

  return (
    <div className="flex items-center gap-1" data-testid="mounted-connector-icons">
      {mounted.map((capability) => {
        const TypeIcon = capability.kind === 'mcp' ? Server : Plug;
        const label = capability.kind === 'connector' && (capability.id === 'feishu' || capability.id === 'tmeet')
          ? t.settings.saasConnectors.providers[capability.id]
          : capability.label;
        return (
          <div
            key={capability.key}
            title={label}
            data-testid={`mounted-capability-${capability.kind}-${capability.id}`}
            className="group inline-flex h-[24px] max-w-[180px] shrink-0 items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/70 px-1.5 text-xs text-zinc-200 transition-colors hover:border-zinc-500"
          >
            <TypeIcon className="h-3 w-3 shrink-0 text-badge-info" aria-hidden />
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
        );
      })}
    </div>
  );
};

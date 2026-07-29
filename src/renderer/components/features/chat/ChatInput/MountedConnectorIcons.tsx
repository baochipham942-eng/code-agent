// ============================================================================
// MountedConnectorIcons - 底栏「当前会话挂载的连接器 / MCP」小图标行（2026-07-29 任务 10）
// ============================================================================
// 入口级可视：用户挂上飞书等连接器后，底栏权限徽章旁边直接看得到「这轮带着谁」。
// 会话级挂载只在这里出现（不进文字区 chip，那是单轮语义）；点击图标即取消挂载。
// 图标按类型区分：connector 用 Plug、MCP server 用 Server，不用名字首字母猜类型。
// 无挂载时不渲染，不占底栏格子。

import React from 'react';
import { Plug, Server } from 'lucide-react';
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
        return (
          <button
            key={capability.key}
            type="button"
            onClick={() => removeCapability(capability)}
            title={capability.label}
            aria-label={t.chatInput.connectorIconRemoveAria.replace('{name}', capability.label)}
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800/70 text-sky-400 transition-colors hover:border-zinc-500 hover:text-sky-300"
          >
            <TypeIcon className="h-3 w-3" aria-hidden />
          </button>
        );
      })}
    </div>
  );
};

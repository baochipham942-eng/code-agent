// ============================================================================
// ContextPanel - 右侧 Context Tab 容器
// 挂载 ContextHealthPanel 并提供面板级 padding/scroll；
// 接 onNavigate / onUnload 把 source 操作路由到 SkillsPanel / skillStore。
// ============================================================================

import React from 'react';
import { toast } from '../hooks/useToast';
import ipcService from '../services/ipcService';
import { useAppStore } from '../stores/appStore';
import { useSkillStore } from '../stores/skillStore';
import { ContextHealthPanel } from './ContextHealthPanel';
import { IPC_DOMAINS } from '@shared/ipc';
import type { SourceTag } from '@shared/contract/contextHealth';

export const ContextPanel: React.FC = () => {
  const contextHealth = useAppStore((s) => s.contextHealth);
  const openWorkbenchTab = useAppStore((s) => s.openWorkbenchTab);
  const setActiveWorkbenchTab = useAppStore((s) => s.setActiveWorkbenchTab);
  const setWorkbenchHighlight = useAppStore((s) => s.setWorkbenchHighlight);
  const unmountSkill = useSkillStore((s) => s.unmountSkill);

  // 跳转：切到对应面板 + 设置 highlight，让目标面板自己滚动 + 闪烁
  const handleNavigate = (target: SourceTag) => {
    switch (target.type) {
      case 'skill':
        openWorkbenchTab('skills');
        setActiveWorkbenchTab('skills');
        setWorkbenchHighlight({ kind: 'skill', name: target.name });
        break;
      case 'mcp':
        // MCP 当前没有独立面板，先切到 skills 并 hint
        openWorkbenchTab('skills');
        setActiveWorkbenchTab('skills');
        setWorkbenchHighlight({ kind: 'mcp', name: target.server });
        toast.info(`MCP server: ${target.server}（详细管理请到设置）`);
        break;
      case 'subagent':
        setWorkbenchHighlight({ kind: 'subagent', name: target.name });
        toast.info(`Subagent: ${target.name}（执行完即移除占用）`);
        break;
    }
  };

  // 卸载：skill 调 store.unmountSkill；其他类型提示用户去对应入口
  const handleUnload = async (target: SourceTag) => {
    switch (target.type) {
      case 'skill':
        try {
          await unmountSkill(target.name);
          toast.success(`已卸载 skill: ${target.name}`);
        } catch (err) {
          toast.error(`卸载失败: ${err instanceof Error ? err.message : '未知错误'}`);
        }
        break;
      case 'mcp':
        try {
          await ipcService.invokeDomain(IPC_DOMAINS.MCP, 'setServerEnabled', {
            serverName: target.server,
            enabled: false,
          });
          toast.success(`已禁用 MCP server: ${target.server}`);
        } catch (err) {
          toast.error(`禁用失败: ${err instanceof Error ? err.message : '未知错误'}`);
        }
        break;
      case 'subagent':
        toast.info('Subagent 执行完会自动从占用中移除');
        break;
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-zinc-950">
      {contextHealth ? (
        <ContextHealthPanel
          health={contextHealth}
          collapsed={false}
          onNavigate={handleNavigate}
          onUnload={handleUnload}
        />
      ) : (
        <div className="p-6 text-sm text-zinc-500">
          <p>暂无上下文数据。</p>
          <p className="mt-2 text-xs text-zinc-600">
            发送一条消息或挂载 skill / MCP 后会自动出现。
          </p>
        </div>
      )}
    </div>
  );
};

export default ContextPanel;

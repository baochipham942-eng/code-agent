// ============================================================================
// SwarmInlineMonitor - 主消息流底部 sticky 浮层，跟踪所有活跃子 Agent
// ============================================================================
// 对照 Codex 截图："5 background agents (@ to tag agents)" 浮层一直挂在
// ChatInput 之上，每个 agent 一行：彩色名字 + role + 状态 + Open 按钮。
// CA 之前 swarm 状态藏在右侧 SwarmMonitor Tab，要切换才能看；这层让它跟随
// 消息流一直可见，不强迫用户跳屏。
//
// 仅在 swarm 实际运行时（agents 列表有 active 的）显示，不污染普通对话。
// ============================================================================

import React, { useState } from 'react';
import { Bot, ChevronUp, ChevronDown, Square, ExternalLink } from 'lucide-react';
import { useSwarmStore } from '../../../stores/swarmStore';
import { useAppStore } from '../../../stores/appStore';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AgentStatus, SwarmAgentState } from '@shared/contract/swarm';
import ipcService from '../../../services/ipcService';

const AGENT_COLORS = [
  'text-emerald-400',
  'text-purple-400',
  'text-cyan-400',
  'text-amber-400',
  'text-pink-400',
  'text-blue-400',
] as const;

function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return AGENT_COLORS[Math.abs(h) % AGENT_COLORS.length];
}

const STATUS_TEXT: Record<AgentStatus, string> = {
  pending: '等待依赖',
  ready: 'awaiting instruction',
  running: 'is working',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const STATUS_COLOR: Record<AgentStatus, string> = {
  pending: 'text-zinc-500',
  ready: 'text-amber-400',
  running: 'text-emerald-400',
  completed: 'text-zinc-500',
  failed: 'text-red-400',
  cancelled: 'text-zinc-500',
};

function isActive(s: AgentStatus): boolean {
  return s === 'pending' || s === 'ready' || s === 'running';
}

export async function cancelSwarmRunOrFallback(activeAgents: Array<Pick<SwarmAgentState, 'id'>>): Promise<void> {
  const cancelledRun = await ipcService
    .invoke(IPC_CHANNELS.SWARM_CANCEL_RUN)
    .catch(() => false);

  if (cancelledRun) return;

  await Promise.all(
    activeAgents.map((agent) =>
      ipcService.invoke(IPC_CHANNELS.SWARM_CANCEL_AGENT, { agentId: agent.id }).catch(() => {
        // 单个 cancel 失败不阻塞其他 agent，swarm event 会让 UI 自动收敛。
      }),
    ),
  );
}

export function SwarmInlineMonitor() {
  const agents = useSwarmStore((s) => s.agents ?? []);
  const isRunning = useSwarmStore((s) => s.isRunning ?? false);
  const [collapsed, setCollapsed] = useState(false);
  const [stopping, setStopping] = useState(false);

  const activeAgents = agents.filter((a) => isActive(a.status));
  // swarm 没跑或没活跃 agent 时不渲染
  if (!isRunning && activeAgents.length === 0) return null;
  if (agents.length === 0) return null;

  const handleStopAll = async () => {
    if (stopping || activeAgents.length === 0) return;
    setStopping(true);
    try {
      await cancelSwarmRunOrFallback(activeAgents);
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/95 backdrop-blur-sm shadow-xl text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        <Bot size={14} className="text-zinc-400" />
        <span className="text-zinc-300">
          {activeAgents.length} background agent{activeAgents.length > 1 ? 's' : ''}
        </span>
        <span className="text-zinc-500">(@ to tag agents)</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={handleStopAll}
            disabled={stopping || activeAgents.length === 0}
            className={`transition-colors ${
              stopping
                ? 'text-zinc-600 cursor-wait'
                : 'text-zinc-400 hover:text-red-400'
            } disabled:cursor-not-allowed disabled:opacity-50`}
            title={stopping ? '正在停止…' : `停止全部 ${activeAgents.length} 个 agent`}
          >
            <Square size={12} />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="text-zinc-400 hover:text-zinc-200 transition-colors"
            title={collapsed ? '展开' : '折叠'}
          >
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="border-t border-zinc-700/40 max-h-48 overflow-y-auto">
          {agents.map((agent) => (
            <SwarmAgentRow key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}

function SwarmAgentRow({ agent }: { agent: SwarmAgentState }) {
  const colorClass = colorFor(agent.id);
  const openWorkbenchTab = useAppStore((s) => s.openWorkbenchTab);
  const setTaskPanelTab = useAppStore((s) => s.setTaskPanelTab);
  const setSelectedSwarmAgentId = useAppStore((s) => s.setSelectedSwarmAgentId);

  const handleOpen = () => {
    // 三步打开 SwarmMonitor 面板 + 切到 monitor tab + focus 这个 agent
    // —— 让用户从底部浮层一键跳到右侧详细视图，不用手动切 tab
    openWorkbenchTab('task');
    setTaskPanelTab('monitor');
    setSelectedSwarmAgentId(agent.id);
  };

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800/40 transition-colors">
      <span className={`font-semibold ${colorClass}`}>{agent.name || agent.id.slice(0, 8)}</span>
      <span className="text-zinc-500">({agent.role})</span>
      <span className={`${STATUS_COLOR[agent.status]} ${agent.status === 'running' ? 'italic' : ''}`}>
        {STATUS_TEXT[agent.status]}
      </span>
      <button
        type="button"
        onClick={handleOpen}
        className="ml-auto flex items-center gap-1 text-zinc-500 hover:text-zinc-200 transition-colors"
        title={`查看 ${agent.name || agent.id} 详情`}
      >
        Open
        <ExternalLink size={10} />
      </button>
    </div>
  );
}

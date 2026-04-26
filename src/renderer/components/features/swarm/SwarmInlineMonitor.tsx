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
import type { AgentStatus, SwarmAgentState } from '@shared/contract/swarm';

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

export function SwarmInlineMonitor() {
  const agents = useSwarmStore((s) => s.agents);
  const isRunning = useSwarmStore((s) => s.isRunning);
  const [collapsed, setCollapsed] = useState(false);

  const activeAgents = agents.filter((a) => isActive(a.status));
  // swarm 没跑或没活跃 agent 时不渲染
  if (!isRunning && activeAgents.length === 0) return null;
  if (agents.length === 0) return null;

  return (
    <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/95 backdrop-blur-sm shadow-xl text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        <Bot size={14} className="text-zinc-400" />
        <span className="text-zinc-300">
          {activeAgents.length} background agent{activeAgents.length > 1 ? 's' : ''}
        </span>
        <span className="text-zinc-500">(@ to tag agents)</span>
        <div className="ml-auto flex items-center gap-2">
          {/* 停止按钮预留位（实际停止逻辑后续接 IPC） */}
          <button
            type="button"
            className="text-zinc-500 hover:text-red-400 transition-colors"
            title="停止所有 agent（待接通）"
            disabled
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
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800/40 transition-colors">
      <span className={`font-semibold ${colorClass}`}>{agent.name || agent.id.slice(0, 8)}</span>
      <span className="text-zinc-500">({agent.role})</span>
      <span className={`${STATUS_COLOR[agent.status]} ${agent.status === 'running' ? 'italic' : ''}`}>
        {STATUS_TEXT[agent.status]}
      </span>
      <button
        type="button"
        className="ml-auto flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors"
        title={`查看 ${agent.name || agent.id} 详情（在右侧 SwarmMonitor 面板）`}
      >
        Open
        <ExternalLink size={10} />
      </button>
    </div>
  );
}

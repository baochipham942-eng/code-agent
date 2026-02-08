// ============================================================================
// SwarmMonitor - Agent Swarm 实时监控面板
// ============================================================================
// 参考 claude-sneakpeek 的 openfactory-exec 进程树监控设计
// ============================================================================

import React, { useEffect, useMemo } from 'react';
import {
  Users,
  Activity,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  Pause,
  Zap,
  Hash,
  ChevronRight,
  X,
} from 'lucide-react';
import { useSwarmStore } from '../../../stores/swarmStore';
import type { SwarmAgentState } from '@shared/types/swarm';

// Agent 状态颜色映射
const statusColors: Record<string, { bg: string; text: string; border: string }> = {
  pending: { bg: 'bg-zinc-500/10', text: 'text-zinc-400', border: 'border-zinc-500/30' },
  ready: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
  running: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
  completed: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  failed: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
  cancelled: { bg: 'bg-zinc-500/10', text: 'text-zinc-500', border: 'border-zinc-500/30' },
};

// 状态图标
const StatusIcon: React.FC<{ status: string }> = ({ status }) => {
  switch (status) {
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 animate-spin" />;
    case 'completed':
      return <CheckCircle className="w-3.5 h-3.5" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5" />;
    case 'cancelled':
      return <Pause className="w-3.5 h-3.5" />;
    case 'ready':
      return <Activity className="w-3.5 h-3.5" />;
    default:
      return <Clock className="w-3.5 h-3.5" />;
  }
};

// 格式化时间
const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
};

// 格式化 Token 数量
const formatTokens = (tokens: number): string => {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1000000).toFixed(2)}M`;
};

// Agent 卡片组件
const AgentCard: React.FC<{ agent: SwarmAgentState }> = ({ agent }) => {
  const colors = statusColors[agent.status] || statusColors.pending;
  const duration = agent.startTime
    ? (agent.endTime || Date.now()) - agent.startTime
    : 0;

  return (
    <div
      className={`px-3 py-2.5 rounded-lg border ${colors.border} ${colors.bg} transition-all`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1.5">
        <div className={colors.text}>
          <StatusIcon status={agent.status} />
        </div>
        <span className="text-sm font-medium text-zinc-200 truncate flex-1">
          {agent.name}
        </span>
        <span className={`text-xs px-1.5 py-0.5 rounded ${colors.bg} ${colors.text}`}>
          {agent.role}
        </span>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 text-xs text-zinc-500">
        {/* Duration */}
        {agent.startTime && (
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatDuration(duration)}
          </span>
        )}

        {/* Iterations */}
        <span className="flex items-center gap-1">
          <Hash className="w-3 h-3" />
          {agent.iterations}
        </span>

        {/* Token Usage */}
        {agent.tokenUsage && (
          <span className="flex items-center gap-1">
            <Zap className="w-3 h-3" />
            {formatTokens(agent.tokenUsage.input + agent.tokenUsage.output)}
          </span>
        )}

        {/* Tool Calls */}
        {agent.toolCalls !== undefined && agent.toolCalls > 0 && (
          <span className="flex items-center gap-1">
            🔧 {agent.toolCalls}
          </span>
        )}
      </div>

      {/* Error Message */}
      {agent.error && (
        <div className="mt-1.5 text-xs text-red-400 truncate">
          {agent.error}
        </div>
      )}

      {/* Last Report */}
      {agent.lastReport && agent.status === 'running' && (
        <div className="mt-1.5 text-xs text-zinc-500 truncate">
          {agent.lastReport}
        </div>
      )}
    </div>
  );
};

// 统计卡片
const StatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subValue?: string;
  color?: string;
}> = ({ icon, label, value, subValue, color = 'text-zinc-400' }) => (
  <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/50 rounded-lg">
    <div className={color}>{icon}</div>
    <div>
      <div className="text-sm font-medium text-zinc-200">{value}</div>
      <div className="text-xs text-zinc-500">
        {label}
        {subValue && <span className="ml-1 text-zinc-600">({subValue})</span>}
      </div>
    </div>
  </div>
);

interface SwarmMonitorProps {
  onClose?: () => void;
}

export const SwarmMonitor: React.FC<SwarmMonitorProps> = ({ onClose }) => {
  const { isRunning, startTime, agents, statistics } = useSwarmStore();

  // 按状态分组 agents
  const groupedAgents = useMemo(() => {
    const running = agents.filter((a) => a.status === 'running');
    const pending = agents.filter((a) => a.status === 'pending' || a.status === 'ready');
    const completed = agents.filter((a) => a.status === 'completed');
    const failed = agents.filter((a) => a.status === 'failed' || a.status === 'cancelled');
    return { running, pending, completed, failed };
  }, [agents]);

  // 监听 IPC 事件
  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubscribe = window.electronAPI.on('swarm:event', (event) => {
      useSwarmStore.getState().handleEvent(event);
    });
    return () => unsubscribe();
  }, []);

  // 计算运行时间
  const elapsedTime = startTime ? Date.now() - startTime : 0;

  // 如果没有 agent，显示空状态
  if (agents.length === 0 && !isRunning) {
    return (
      <div className="w-80 flex flex-col border-l border-zinc-800 bg-zinc-900/50">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-zinc-200">Swarm Monitor</h3>
            <p className="text-xs text-zinc-500 mt-0.5">Agent 协作监控</p>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-zinc-500">
            <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">暂无活跃的 Agent Swarm</p>
            <p className="text-xs mt-1">当复杂任务触发多 Agent 协作时显示</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-80 flex flex-col border-l border-zinc-800 bg-zinc-900/50">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-zinc-200 flex items-center gap-2">
            Swarm Monitor
            {isRunning && (
              <span className="flex items-center gap-1 text-xs text-amber-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                运行中
              </span>
            )}
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {statistics.total} 个 Agent · {formatDuration(elapsedTime)}
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Statistics */}
      <div className="px-3 py-2 border-b border-zinc-800/50">
        <div className="grid grid-cols-2 gap-2">
          <StatCard
            icon={<Activity className="w-4 h-4" />}
            label="并行峰值"
            value={statistics.parallelPeak}
            color="text-amber-400"
          />
          <StatCard
            icon={<Zap className="w-4 h-4" />}
            label="总 Token"
            value={formatTokens(statistics.totalTokens)}
            color="text-cyan-400"
          />
          <StatCard
            icon={<CheckCircle className="w-4 h-4" />}
            label="已完成"
            value={statistics.completed}
            subValue={`${Math.round((statistics.completed / statistics.total) * 100)}%`}
            color="text-emerald-400"
          />
          <StatCard
            icon={<Hash className="w-4 h-4" />}
            label="工具调用"
            value={statistics.totalToolCalls}
            color="text-blue-400"
          />
        </div>
      </div>

      {/* Agent List */}
      <div className="flex-1 overflow-y-auto">
        {/* Running */}
        {groupedAgents.running.length > 0 && (
          <AgentSection
            title="运行中"
            icon={<Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />}
            agents={groupedAgents.running}
            defaultExpanded
          />
        )}

        {/* Pending */}
        {groupedAgents.pending.length > 0 && (
          <AgentSection
            title="等待中"
            icon={<Clock className="w-3.5 h-3.5 text-zinc-400" />}
            agents={groupedAgents.pending}
          />
        )}

        {/* Completed */}
        {groupedAgents.completed.length > 0 && (
          <AgentSection
            title="已完成"
            icon={<CheckCircle className="w-3.5 h-3.5 text-emerald-400" />}
            agents={groupedAgents.completed}
          />
        )}

        {/* Failed */}
        {groupedAgents.failed.length > 0 && (
          <AgentSection
            title="失败"
            icon={<XCircle className="w-3.5 h-3.5 text-red-400" />}
            agents={groupedAgents.failed}
            defaultExpanded
          />
        )}
      </div>
    </div>
  );
};

// Agent 分组组件
const AgentSection: React.FC<{
  title: string;
  icon: React.ReactNode;
  agents: SwarmAgentState[];
  defaultExpanded?: boolean;
}> = ({ title, icon, agents, defaultExpanded = false }) => {
  const [expanded, setExpanded] = React.useState(defaultExpanded);

  return (
    <div className="border-b border-zinc-800/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-zinc-800/30 transition-colors"
      >
        <ChevronRight
          className={`w-4 h-4 text-zinc-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        {icon}
        <span className="text-sm text-zinc-300 flex-1 text-left">{title}</span>
        <span className="text-xs text-zinc-500 px-1.5 py-0.5 rounded bg-zinc-800">
          {agents.length}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
};

export default SwarmMonitor;

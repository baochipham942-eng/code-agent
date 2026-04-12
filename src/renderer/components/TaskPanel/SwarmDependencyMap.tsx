import React, { useMemo } from 'react';
import DAGViewer, { type DAGVisualizationState } from '../features/workflow/DAGViewer';
import type { DAGStatus, TaskPriority, TaskStatus } from '@shared/contract/taskDAG';
import type {
  SwarmAgentContextSnapshot,
  SwarmAgentState,
  SwarmLaunchRequest,
} from '@shared/contract/swarm';
import type { SwarmExecutionPhase } from '../../stores/swarmStore';

const PHASE_STATUS_MAP: Record<SwarmExecutionPhase, DAGStatus> = {
  idle: 'idle',
  planning: 'running',
  waiting_approval: 'running',
  executing: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const toTaskStatus = (status: SwarmAgentState['status']): TaskStatus => status;

const buildContextUsage = (snapshot?: SwarmAgentContextSnapshot) => {
  if (!snapshot) return { percent: 0, warningLevel: 'normal' as const };
  return { percent: snapshot.usagePercent, warningLevel: snapshot.warningLevel };
};

const SwarmDependencyMap: React.FC<{
  launchRequest?: SwarmLaunchRequest;
  agents: SwarmAgentState[];
  phase: SwarmExecutionPhase;
  parallelPeak?: number;
  lastEventAt?: number;
  selectedAgentId: string | null;
  onAgentSelect: (agentId: string | null) => void;
}> = ({ launchRequest, agents, phase, parallelPeak, lastEventAt, selectedAgentId, onAgentSelect }) => {
  const dagState = useMemo<DAGVisualizationState | null>(() => {
    if (!launchRequest || launchRequest.tasks.length === 0) return null;

    const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
    let earliestStart = launchRequest.requestedAt;
    let latestFinish = lastEventAt ?? 0;

    const nodes: DAGVisualizationState['nodes'] = launchRequest.tasks.map((task) => {
      const agent = agentMap.get(task.id);
      const { percent, warningLevel } = buildContextUsage(agent?.contextSnapshot);
      const startedAt = agent?.startTime;
      const completedAt = agent?.endTime;

      if (typeof startedAt === 'number') {
        earliestStart = Math.min(earliestStart, startedAt);
      }
      if (typeof completedAt === 'number') {
        latestFinish = Math.max(latestFinish, completedAt);
      }

      const duration = typeof startedAt === 'number' && typeof completedAt === 'number'
        ? completedAt - startedAt
        : undefined;

      const priority: TaskPriority = task.writeAccess ? 'critical' : 'normal';

      return {
        id: task.id,
        position: { x: 0, y: 0 },
        type: 'task' as const,
        data: {
          taskId: task.id,
          name: task.role,
          description: task.task,
          type: 'agent' as const,
          status: agent ? toTaskStatus(agent.status) : 'pending',
          priority,
          role: task.role,
          startedAt,
          completedAt,
          duration,
          retryCount: 0,
          toolsUsed: task.tools,
          iterations: agent?.iterations,
          cost: agent?.cost,
          isHighlighted: warningLevel !== 'normal' || percent >= 80,
          contextUsage: percent,
          contextWarning: warningLevel,
        },
      };
    });

    const taskIds = new Set(nodes.map((node) => node.id));
    const edges: DAGVisualizationState['edges'] = [];
    launchRequest.tasks.forEach((task) => {
      (task.dependsOn ?? []).forEach((dependency) => {
        if (!taskIds.has(dependency)) return;
        const isActive = nodes
          .find((candidate) => candidate.id === dependency)
          ?.data.status === 'running';
        edges.push({
          id: `edge-${dependency}-${task.id}`,
          source: dependency,
          target: task.id,
          type: 'dependency',
          data: {
            dependencyType: 'data',
            isActive,
          },
        });
      });
    });

    const statusCounters: Record<TaskStatus, number> = {
      pending: 0,
      ready: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    };
    nodes.forEach((node) => {
      const status = node.data.status;
      statusCounters[status] = (statusCounters[status] ?? 0) + 1;
    });

    const totalDuration = nodes.reduce<number>((sum, node) => {
      const duration = typeof node.data.duration === 'number' ? node.data.duration : 0;
      return sum + duration;
    }, 0);
    const totalCost = nodes.reduce<number>((sum, node) => {
      const cost = typeof node.data.cost === 'number' ? node.data.cost : 0;
      return sum + cost;
    }, 0);

    const statistics: DAGVisualizationState['statistics'] = {
      totalTasks: nodes.length,
      completedTasks: statusCounters.completed,
      failedTasks: statusCounters.failed,
      skippedTasks: statusCounters.skipped,
      runningTasks: statusCounters.running,
      pendingTasks: statusCounters.pending,
      readyTasks: statusCounters.ready,
      totalDuration,
      totalCost,
      maxParallelism: Math.max(parallelPeak ?? 1, 1),
    };

    return {
      dagId: launchRequest.id,
      name: launchRequest.summary,
      description: `${launchRequest.agentCount} 个 agent · ${launchRequest.dependencyCount} 条依赖`,
      status: PHASE_STATUS_MAP[phase] ?? 'running',
      statistics,
      nodes,
      edges,
      startedAt: earliestStart,
      completedAt: latestFinish || undefined,
    };
  }, [launchRequest, agents, phase, parallelPeak, lastEventAt]);

  const warns = useMemo(() => {
    if (!dagState) return [];
    return dagState.nodes.filter((node) => Boolean(node.data.contextWarning) && node.data.contextWarning !== 'normal');
  }, [dagState]);

  if (!dagState) {
    return (
      <div className="rounded-lg border border-white/[0.04] bg-zinc-900/50 px-3 py-6 text-xs text-zinc-400">
        等待并行任务编排数据。
      </div>
    );
  }

  const averageUsage = dagState.nodes.length > 0
    ? dagState.nodes.reduce<number>((sum, node) => {
        const usage = typeof node.data.contextUsage === 'number' ? node.data.contextUsage : 0;
        return sum + usage;
      }, 0) / dagState.nodes.length
    : 0;

  return (
    <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3 space-y-3">
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>依赖拓扑</span>
        <span className="text-[11px] uppercase tracking-wide">Avg context {averageUsage.toFixed(1)}%</span>
      </div>
      <div className="h-[320px] rounded-lg border border-white/[0.02] bg-zinc-900/80">
        <DAGViewer
          dagState={dagState}
          showControls={false}
          showMiniMap={false}
          showBackground={false}
          height="100%"
          selectedTaskId={selectedAgentId}
          onSelectedTaskIdChange={onAgentSelect}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-400">
        <span>节点 {dagState.nodes.length}</span>
        <span>依赖 {dagState.edges.length}</span>
        <span>上下文告警 {warns.length}</span>
        {warns.length > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">
            {warns.length} 个 agent 接近上下文上限
          </span>
        )}
      </div>
    </div>
  );
};

export default SwarmDependencyMap;

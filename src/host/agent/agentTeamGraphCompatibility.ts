import type { SwarmRunScope } from '../../shared/contract/swarm';
import { GraphEventCompatibilityAdapter } from '../orchestration/graphEventCompatibilityAdapter';
import type { AggregatedTeamResult } from './resultAggregator';
import type { AgentTask, ParallelExecutionResult } from './parallelAgentCoordinatorTypes';
import type { SwarmEventEmitter } from './swarmEventPublisher';

export interface AgentTeamTerminalProjection {
  cancelled: boolean;
  result: ParallelExecutionResult;
  aggregation: AggregatedTeamResult;
}

export function createAgentTeamGraphCompatibility(input: {
  emitter: SwarmEventEmitter;
  scope: SwarmRunScope;
  tasks: AgentTask[];
}) {
  let terminalProjection: AgentTeamTerminalProjection | undefined;
  const adapter = new GraphEventCompatibilityAdapter({
    graph: (event) => {
      if (event.type === 'graph_started') input.emitter.started(input.scope, input.tasks.length);
      if (event.type === 'node_queued' && event.nodeId) {
        const task = input.tasks.find((candidate) => candidate.id === event.nodeId);
        if (task) {
          input.emitter.agentAdded(input.scope, {
            id: task.id,
            name: task.role,
            role: task.role,
            dispatchedTask: task.task,
          });
        }
      }
      if (
        event.type !== 'graph_completed'
        && event.type !== 'graph_failed'
        && event.type !== 'graph_cancelled'
      ) return;
      if (!terminalProjection || terminalProjection.cancelled || event.type === 'graph_cancelled') {
        input.emitter.cancelled(input.scope);
        return;
      }
      const { result, aggregation } = terminalProjection;
      input.emitter.completedWithAggregation(input.scope, {
        total: input.tasks.length,
        completed: result.results.filter((entry) => entry.success).length,
        failed: result.results.filter((entry) => !entry.success).length,
        parallelPeak: result.parallelism,
        totalTime: result.totalDuration,
      }, {
        summary: aggregation.summary,
        filesChanged: aggregation.filesChanged,
        totalCost: aggregation.totalCost,
        totalDuration: aggregation.totalDuration,
        speedup: aggregation.speedup,
        successRate: aggregation.successRate,
        totalIterations: aggregation.totalIterations,
      });
    },
    diagnostic: (error, event, target) => console.warn(
      `[SpawnAgent] Graph compatibility projection failed (${target}, ${event.graphId})`,
      error,
    ),
  }, { deferTerminals: true });

  return {
    adapter,
    setTerminalProjection(projection: AgentTeamTerminalProjection): void {
      terminalProjection = projection;
    },
  };
}

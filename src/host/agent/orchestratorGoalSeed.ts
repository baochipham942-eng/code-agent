// ============================================================================
// Orchestrator Goal Seed — /goal 自治模式的 todos/tasks 播种
// ----------------------------------------------------------------------------
// goalContract 建好后，把目标铺成种子 todos、落进 session todos + 同步成 session
// tasks，并发 todo_update / task_update 两个事件。从 run 主线抽出（F-4c）：
// 播种是编排胶水，goalContract 本身的构造留在 goalModeController。
// ============================================================================

import type { AgentEvent } from '../../shared/contract';
import type { GoalContract } from './goalModeController';
import { buildGoalSeedTodos } from '../../shared/utils/goalTodos';
import { setSessionTodos, syncTodosToSessionTasks } from './todoParser';

export function seedGoalContractForRun(input: {
  goalContract: GoalContract;
  sessionId: string;
  emitEvent: (event: AgentEvent) => void;
}): void {
  const goalSeedTodos = buildGoalSeedTodos(input.goalContract.goal);
  setSessionTodos(input.sessionId, goalSeedTodos);
  const taskSync = syncTodosToSessionTasks(input.sessionId, goalSeedTodos);
  input.emitEvent({ type: 'todo_update', data: goalSeedTodos });
  input.emitEvent({
    type: 'task_update',
    data: {
      tasks: taskSync.tasks,
      action: 'sync',
      taskIds: [
        ...taskSync.created.map((task) => task.id),
        ...taskSync.updated.map((task) => task.id),
      ],
      source: 'goal_mode',
    },
  });
}

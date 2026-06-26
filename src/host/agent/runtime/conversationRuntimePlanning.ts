import type { Message, TaskPlan, TodoItem } from '../../../shared/contract';
import { getSessionTodos } from '../../agent/todoParser';
import type { RuntimeContext } from './runtimeContext';

export function queueRuntimeDiagnostic(ctx: RuntimeContext, message: string): void {
  const trimmed = message.trim();
  if (!trimmed) return;
  ctx.pendingRuntimeDiagnostics.push(trimmed);
}

export function hasActiveSessionTodos(sessionId?: string): boolean {
  return getSessionTodos(sessionId).some((todo) => todo.status !== 'completed');
}

export function isSessionFirstUserTurn(messages: Message[]): boolean {
  const userTurnCount = messages.filter((message) => (
    message.role === 'user'
    && message.metadata?.workbench?.runtimeInputMode !== 'supplement'
  )).length;
  return userTurnCount <= 1;
}

export function todosFromPlan(plan: TaskPlan): TodoItem[] {
  return plan.phases.flatMap((phase) =>
    phase.steps.map((step) => ({
      content: step.content,
      status: step.status === 'completed' || step.status === 'skipped'
        ? 'completed'
        : step.status,
      activeForm: step.activeForm || step.content,
    })),
  );
}

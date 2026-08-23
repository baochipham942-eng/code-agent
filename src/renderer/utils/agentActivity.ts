import type { LastToolStep } from '@shared/contract/backgroundTask';
import type { Translations } from '../i18n';
import { humanizeToolStep } from './humanizeToolStep';

export function describeLastToolStep(
  step: LastToolStep | undefined,
  t: Translations,
): string {
  if (!step) return t.chat.activityIdle;
  const targetArgs = step.target
    ? {
      file_path: step.target,
      path: step.target,
      notebook_path: step.target,
      command: step.target,
      agentId: step.target,
      target: step.target,
    }
    : undefined;
  return humanizeToolStep(step.tool, targetArgs, t);
}

export function isDelegationTool(name: string): boolean {
  return name === 'delegate_task' || name === 'spawn_agent';
}

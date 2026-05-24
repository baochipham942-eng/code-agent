import type { TodoItem } from '../contract/planning';

function truncateGoal(goal: string, max = 120): string {
  const trimmed = goal.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

export function buildGoalSeedTodos(goal: string): TodoItem[] {
  const title = truncateGoal(goal);
  return [
    {
      content: `任务目标：${title}`,
      status: 'completed',
      activeForm: `目标：${title}`,
    },
    {
      content: '拆解实现步骤和验收条件',
      status: 'in_progress',
      activeForm: '拆解目标，确认首轮行动',
    },
    {
      content: '实现核心交付物',
      status: 'pending',
      activeForm: '实现核心交付物',
    },
    {
      content: '验证结果并补齐证据',
      status: 'pending',
      activeForm: '运行验证并补齐证据',
    },
    {
      content: '申请目标完成并通过闸门',
      status: 'pending',
      activeForm: '申请完成并等待验证',
    },
  ];
}

import { describe, expect, it } from 'vitest';
import { buildGoalSeedTodos } from '../../../src/shared/utils/goalTodos';

describe('buildGoalSeedTodos', () => {
  it('creates visible starter tasks for a bare goal run', () => {
    const todos = buildGoalSeedTodos('开发一个html弹砖块的游戏，要求技能和关卡丰富，可玩性强');

    expect(todos.map((todo) => todo.content)).toEqual([
      '任务目标：开发一个html弹砖块的游戏，要求技能和关卡丰富，可玩性强',
      '拆解实现步骤和验收条件',
      '实现核心交付物',
      '验证结果并补齐证据',
      '申请目标完成并通过闸门',
    ]);
    expect(todos.map((todo) => todo.status)).toEqual([
      'completed',
      'in_progress',
      'pending',
      'pending',
      'pending',
    ]);
  });
});

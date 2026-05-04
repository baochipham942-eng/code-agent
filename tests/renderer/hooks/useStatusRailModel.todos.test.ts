import { describe, expect, it } from 'vitest';
import { deriveStatusRailTodoModel } from '../../../src/renderer/hooks/useStatusRailModel';
import type { TaskPlan, TodoItem } from '../../../src/shared/contract';

const plan: TaskPlan = {
  id: 'plan-1',
  title: 'Fix todo extraction',
  objective: 'Use real planning data in the right rail',
  createdAt: 1,
  updatedAt: 1,
  metadata: {
    totalSteps: 3,
    completedSteps: 1,
    blockedSteps: 0,
  },
  phases: [
    {
      id: 'phase-1',
      title: 'Implementation',
      status: 'in_progress',
      steps: [
        {
          id: 'step-1',
          content: 'Find the broken todo source',
          status: 'completed',
          activeForm: 'Finding the broken todo source',
        },
        {
          id: 'step-2',
          content: 'Wire plan steps into the rail',
          status: 'in_progress',
          activeForm: 'Wiring plan steps into the rail',
        },
        {
          id: 'step-3',
          content: 'Verify the UI no longer shows tools as todos',
          status: 'pending',
        },
      ],
    },
  ],
};

describe('deriveStatusRailTodoModel', () => {
  it('uses explicit session todos before task plan steps', () => {
    const sessionTodos: TodoItem[] = [
      {
        content: 'Session todo',
        status: 'in_progress',
        activeForm: 'Working session todo',
      },
    ];

    const model = deriveStatusRailTodoModel(sessionTodos, plan);

    expect(model.items).toEqual(sessionTodos);
    expect(model.completed).toBe(0);
    expect(model.total).toBe(1);
  });

  it('maps task plan steps when no session todos exist', () => {
    const model = deriveStatusRailTodoModel([], plan);

    expect(model.total).toBe(3);
    expect(model.completed).toBe(1);
    expect(model.items.map((item) => item.content)).toEqual([
      'Find the broken todo source',
      'Wire plan steps into the rail',
      'Verify the UI no longer shows tools as todos',
    ]);
    expect(model.items[1]).toMatchObject({
      status: 'in_progress',
      activeForm: 'Wiring plan steps into the rail',
    });
    expect(model.items[2]).toMatchObject({
      status: 'pending',
      activeForm: 'Verify the UI no longer shows tools as todos',
    });
  });
});

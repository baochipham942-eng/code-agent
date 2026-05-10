import { describe, expect, it } from 'vitest';
import {
  deriveStatusRailTodoModel,
  isGenericAutoPlanTodoList,
} from '../../../src/renderer/hooks/useStatusRailModel';
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

  it('hides generic auto-plan placeholder todos from session state', () => {
    const sessionTodos: TodoItem[] = [
      { content: 'Understand the feature requirements', status: 'in_progress', activeForm: 'Understanding the feature requirements' },
      { content: 'Identify affected files and components', status: 'pending', activeForm: 'Identifying affected files and components' },
      { content: 'Check for existing patterns to follow', status: 'pending', activeForm: 'Checking for existing patterns to follow' },
      { content: 'Create/modify necessary files', status: 'pending', activeForm: 'Create/modifying necessary files' },
    ];

    expect(isGenericAutoPlanTodoList(sessionTodos)).toBe(true);
    expect(deriveStatusRailTodoModel(sessionTodos, null)).toEqual({
      items: [],
      completed: 0,
      total: 0,
    });
  });

  it('hides generic auto-plan placeholder todos from task plans', () => {
    const genericPlan: TaskPlan = {
      id: 'plan-generic',
      title: 'Generic plan',
      objective: 'Generic plan',
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        totalSteps: 2,
        completedSteps: 0,
        blockedSteps: 0,
      },
      phases: [
        {
          id: 'phase-generic',
          title: 'Implementation',
          status: 'in_progress',
          steps: [
            {
              id: 'step-1',
              content: 'Implement the requested change',
              status: 'in_progress',
              activeForm: 'Implementing the change',
            },
            {
              id: 'step-2',
              content: 'Verify the result',
              status: 'pending',
              activeForm: 'Verifying the result',
            },
          ],
        },
      ],
    };

    expect(deriveStatusRailTodoModel([], genericPlan).items).toEqual([]);
  });

  it('keeps a mixed real todo list visible', () => {
    const sessionTodos: TodoItem[] = [
      { content: 'Understand the feature requirements', status: 'completed', activeForm: 'Understanding the feature requirements' },
      { content: 'Fix hook config search paths', status: 'in_progress', activeForm: 'Fixing hook config search paths' },
    ];

    const model = deriveStatusRailTodoModel(sessionTodos, null);

    expect(model.total).toBe(2);
    expect(model.items.map((item) => item.content)).toEqual([
      'Understand the feature requirements',
      'Fix hook config search paths',
    ]);
  });
});

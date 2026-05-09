import { describe, expect, it } from 'vitest';
import { deriveTaskRailView } from '../../../src/renderer/utils/taskRailPresentation';
import type { TaskRecord } from '../../../src/renderer/types/runWorkbench';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    scope: 'session',
    title: '处理当前请求',
    status: 'in_progress',
    steps: [],
    ...overrides,
  };
}

describe('deriveTaskRailView', () => {
  it('uses simple mode for one progress-only task', () => {
    const view = deriveTaskRailView(makeTask({
      title: '生成回复中',
      steps: [{ title: '生成回复中', status: 'in_progress' }],
      resumeHint: '工具：Read · 第 1/3 个工具',
    }));

    expect(view.mode).toBe('simple');
    expect(view.title).toBe('生成回复中');
    expect(view.visibleSteps).toEqual([]);
    expect(view.currentAction).toBe('工具：Read · 第 1/3 个工具');
  });

  it('prioritizes active and pending work while folding completed steps', () => {
    const view = deriveTaskRailView(makeTask({
      title: '实现右侧任务面板',
      steps: [
        { title: '完成一', status: 'done' },
        { title: '完成二', status: 'done' },
        { title: '完成三', status: 'done' },
        { title: '完成四', status: 'done' },
        { title: '改造任务卡展示', status: 'in_progress' },
        { title: '补 helper 单测', status: 'pending' },
        { title: '补组件测试', status: 'pending' },
        { title: '跑定向测试', status: 'pending' },
        { title: '跑 typecheck', status: 'pending' },
        { title: '回读结果', status: 'pending' },
      ],
    }));

    expect(view.mode).toBe('checklist');
    expect(view.visibleSteps.map((step) => step.title)).toEqual([
      '改造任务卡展示',
      '补 helper 单测',
      '补组件测试',
      '跑定向测试',
      '跑 typecheck',
      '回读结果',
    ]);
    expect(view.hiddenCompletedCount).toBe(4);
    expect(view.completed).toBe(4);
    expect(view.total).toBe(10);
  });

  it('orders blocked work before the running step and hides distant pending steps', () => {
    const view = deriveTaskRailView(makeTask({
      title: '修复任务状态',
      status: 'blocked',
      steps: [
        { title: '等待权限', status: 'blocked' },
        { title: '正在整理展示规则', status: 'in_progress' },
        { title: '待办一', status: 'pending' },
        { title: '待办二', status: 'pending' },
        { title: '待办三', status: 'pending' },
        { title: '待办四', status: 'pending' },
        { title: '待办五', status: 'pending' },
        { title: '待办六', status: 'pending' },
        { title: '已完成项', status: 'done' },
      ],
    }));

    expect(view.visibleSteps.map((step) => step.status)).toEqual([
      'blocked',
      'in_progress',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(view.hiddenPendingCount).toBe(2);
    expect(view.hiddenCompletedCount).toBe(1);
  });

  it('does not promote file reads, commands, searches, or tool calls into visible tasks', () => {
    const view = deriveTaskRailView(makeTask({
      title: '给出推荐结论',
      steps: [
        { title: '读取文件', status: 'done' },
        { title: '运行命令', status: 'done' },
        { title: '搜索信息', status: 'done' },
        { title: '调用工具', status: 'done' },
        { title: '给出推荐结论', status: 'in_progress' },
      ],
    }));

    expect(view.mode).toBe('simple');
    expect(view.visibleSteps).toEqual([]);
    expect(view.total).toBe(1);
  });
});

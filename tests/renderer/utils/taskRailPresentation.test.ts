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
        { title: '完成一', status: 'completed' },
        { title: '完成二', status: 'completed' },
        { title: '完成三', status: 'completed' },
        { title: '完成四', status: 'completed' },
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

  it('shows completed checklist steps directly when the whole task is done', () => {
    const view = deriveTaskRailView(makeTask({
      title: '任务目标：验证任务面板复杂任务展示',
      status: 'completed',
      steps: [
        { title: '任务目标：验证任务面板复杂任务展示', status: 'completed' },
        { title: '检查多个子任务', status: 'completed' },
        { title: '验证完成态', status: 'completed' },
      ],
    }));

    expect(view.mode).toBe('checklist');
    expect(view.status).toBe('completed');
    expect(view.title).toBe('任务目标：验证任务面板复杂任务展示');
    expect(view.visibleSteps.map((step) => step.title)).toEqual([
      '任务目标：验证任务面板复杂任务展示',
      '检查多个子任务',
      '验证完成态',
    ]);
    expect(view.hiddenCompletedCount).toBe(0);
    expect(view.completed).toBe(3);
    expect(view.total).toBe(3);
  });

  it('prioritizes actionable work before blocked dependencies', () => {
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
        { title: '已完成项', status: 'completed' },
      ],
    }));

    expect(view.visibleSteps.map((step) => step.status)).toEqual([
      'in_progress',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(view.hiddenPendingCount).toBe(2);
    expect(view.hiddenCompletedCount).toBe(1);
  });

  it('keeps dependency metadata available for richer task rail rendering', () => {
    const view = deriveTaskRailView(makeTask({
      title: '渲染依赖关系',
      status: 'blocked',
      steps: [
        { title: '准备数据源', status: 'pending', blockedTaskTitles: ['渲染依赖状态'] },
        { title: '渲染依赖状态', status: 'blocked', blockedByTitles: ['准备数据源'] },
        { title: '验证解除阻塞', status: 'pending' },
      ],
    }));

    expect(view.dependencySummary).toEqual({ waitingCount: 1, unlockingCount: 1 });
    expect(view.visibleSteps.map((step) => ({
      title: step.title,
      blockedByTitles: step.blockedByTitles,
      blockedTaskTitles: step.blockedTaskTitles,
    }))).toEqual([
      { title: '准备数据源', blockedByTitles: undefined, blockedTaskTitles: ['渲染依赖状态'] },
      { title: '验证解除阻塞', blockedByTitles: undefined, blockedTaskTitles: undefined },
      { title: '渲染依赖状态', blockedByTitles: ['准备数据源'], blockedTaskTitles: undefined },
    ]);
  });

  it('does not promote file reads, commands, searches, or tool calls into visible tasks', () => {
    const view = deriveTaskRailView(makeTask({
      title: '给出推荐结论',
      steps: [
        { title: '读取文件', status: 'completed' },
        { title: '运行命令', status: 'completed' },
        { title: '搜索信息', status: 'completed' },
        { title: '调用工具', status: 'completed' },
        { title: '给出推荐结论', status: 'in_progress' },
      ],
    }));

    expect(view.mode).toBe('simple');
    expect(view.visibleSteps).toEqual([]);
    expect(view.total).toBe(1);
  });

  it('folds cancelled steps and removes them from progress total', () => {
    const view = deriveTaskRailView(makeTask({
      title: '调整计划',
      status: 'in_progress',
      steps: [
        { title: '保留路径', status: 'completed' },
        { title: '放弃旧路径', status: 'cancelled' },
        { title: '继续验证', status: 'in_progress' },
      ],
    }));

    expect(view.visibleSteps.map((step) => step.title)).toEqual(['继续验证']);
    expect(view.completedSteps.map((step) => step.status)).toEqual(['completed', 'cancelled']);
    expect(view.completed).toBe(1);
    expect(view.total).toBe(2);
  });
});

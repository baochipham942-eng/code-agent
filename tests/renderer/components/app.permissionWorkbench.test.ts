import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOpenTaskStatus } from '../../../src/shared/contract/planning';

const appPath = path.resolve(process.cwd(), 'src/renderer/App.tsx');
const appSource = fs.readFileSync(appPath, 'utf8');

describe('App task workbench auto reveal', () => {
  it('只有 needs_decision 任务时面板判定为应展开', () => {
    expect(appSource).toContain('isOpenTaskStatus');
    expect(appSource).toContain('hasOpenSessionTask = sessionTasks.some((task) => isOpenTaskStatus(task.status))');
    expect(appSource).toContain('.filter((task) => isOpenTaskStatus(task.status))');
    expect(isOpenTaskStatus('needs_decision')).toBe(true);
    expect(isOpenTaskStatus('user_action')).toBe(true);
    expect(isOpenTaskStatus('pending')).toBe(true);
    expect(isOpenTaskStatus('completed')).toBe(false);
    expect(isOpenTaskStatus('cancelled')).toBe(false);
    expect([{ status: 'needs_decision' as const }].some((task) => isOpenTaskStatus(task.status))).toBe(true);
    expect([{ status: 'completed' as const }].some((task) => isOpenTaskStatus(task.status))).toBe(false);
  });

  it('待决或排队权限不再构成右栏自动打开信号', () => {
    const start = appSource.indexOf('const hasTaskWorkbenchContent = (');
    const end = appSource.indexOf('\n  );', start);
    const expression = appSource.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(expression).toContain('hasOpenSessionTask');
    expect(expression).toContain('hasOpenTodo');
    expect(expression).toContain('hasBackgroundTaskActivity');
    expect(expression).toContain('hasSwarmActivity');
    expect(expression).toContain('hasWorkflowActivity');
    expect(expression).not.toContain('PermissionRequest');
    expect(appSource).not.toContain('hasVisiblePermissionRequest');
    expect(appSource).not.toContain('hasQueuedPermissionRequest');
  });

  it('ApprovalSyncCard 生产文件和旧测试都不存在', () => {
    expect(fs.existsSync(path.resolve(process.cwd(), 'src/renderer/components/TaskPanel/ApprovalSyncCard.tsx'))).toBe(false);
    expect(fs.existsSync(path.resolve(process.cwd(), 'tests/renderer/components/approvalSyncCard.errorHandling.test.tsx'))).toBe(false);
  });
});

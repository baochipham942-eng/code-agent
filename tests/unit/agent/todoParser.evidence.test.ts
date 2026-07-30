// ============================================================================
// todo 同步链的 ADR-050 证据章：completed 落账不允许空证据
// - 机器推进（auto-advance）带触发它的工具调用证据
// - agent 自己勾掉的 todo 打「自报」章
// - taskStore 兜底门：无证据转 completed 直接 fail-loud（亲手喂坏输入验门真红）
// ============================================================================

import { describe, expect, it } from 'vitest';
import { makeEvidenceRef } from '../../../src/shared/contract/evidence';
import type { TodoItem } from '../../../src/shared/contract';
import { syncTodosToSessionTasks } from '../../../src/host/agent/todoParser';
import { createTask, listTasks, updateTask } from '../../../src/host/services/planning/taskStore';

let sessionSeq = 0;
function freshSession(): string {
  return `todo-evidence-session-${++sessionSeq}`;
}

function todoOf(content: string, status: TodoItem['status']): TodoItem {
  return { content, activeForm: content, status };
}

describe('todo 同步的 completed 证据章', () => {
  it('agent 勾掉的 todo 落账带 self-report 章，不再是空证据', () => {
    const sessionId = freshSession();
    syncTodosToSessionTasks(sessionId, [todoOf('写完周报', 'completed')]);

    const task = listTasks(sessionId).find((t) => t.subject === '写完周报');
    expect(task?.status).toBe('completed');
    expect(task?.evidenceRefs?.length).toBeGreaterThan(0);
    expect(task?.evidenceRefs?.[0]?.source).toBe('todo_parser:self-report');
  });

  it('auto-advance 传入的机器证据原样落账', () => {
    const sessionId = freshSession();
    const machineEvidence = [makeEvidenceRef({
      kind: 'tool',
      ref: 'auto-advance: Edit src/foo.ts (toolCall tc-1)',
      source: 'todo_parser:auto-advance',
    })];
    syncTodosToSessionTasks(sessionId, [todoOf('改配置文件', 'completed')], {
      completionEvidence: machineEvidence,
    });

    const task = listTasks(sessionId).find((t) => t.subject === '改配置文件');
    expect(task?.status).toBe('completed');
    expect(task?.evidenceRefs?.[0]?.source).toBe('todo_parser:auto-advance');
    expect(task?.evidenceRefs?.[0]?.ref).toContain('src/foo.ts');
  });

  it('既有 in_progress 任务被 todo 勾成 completed 时同样带章', () => {
    const sessionId = freshSession();
    syncTodosToSessionTasks(sessionId, [todoOf('联调接口', 'in_progress')]);
    syncTodosToSessionTasks(sessionId, [todoOf('联调接口', 'completed')]);

    const task = listTasks(sessionId).find((t) => t.subject === '联调接口');
    expect(task?.status).toBe('completed');
    expect(task?.evidenceRefs?.[0]?.source).toBe('todo_parser:self-report');
  });
});

describe('taskStore 兜底门（ADR-050 fail-loud）', () => {
  it('无证据把任务转成 completed 直接抛错', () => {
    const sessionId = freshSession();
    const task = createTask(sessionId, { subject: '裸转完成', description: '裸转完成' });
    expect(() => updateTask(sessionId, task.id, { status: 'completed' }))
      .toThrow(/without evidenceRefs/);
  });

  it('带证据转 completed 放行', () => {
    const sessionId = freshSession();
    const task = createTask(sessionId, { subject: '有证据完成', description: '有证据完成' });
    const next = updateTask(sessionId, task.id, {
      status: 'completed',
      evidenceRefs: [makeEvidenceRef({ kind: 'test', ref: 'vitest 3 passed', source: 'gate-test' })],
    });
    expect(next?.status).toBe('completed');
  });

  it('已完成任务的改名等写入不受影响（历史空证据任务不炸）', () => {
    const sessionId = freshSession();
    const task = createTask(sessionId, { subject: '旧任务', description: '旧任务' });
    updateTask(sessionId, task.id, {
      status: 'completed',
      evidenceRefs: [makeEvidenceRef({ kind: 'tool', ref: 'done', source: 'gate-test' })],
    });
    const renamed = updateTask(sessionId, task.id, { subject: '旧任务（改名）', status: 'completed' });
    expect(renamed?.subject).toBe('旧任务（改名）');
  });
});

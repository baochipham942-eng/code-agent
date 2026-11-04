import { describe, expect, it } from 'vitest';
import {
  describeLastToolStep,
  resolveAgentActivityStepStatus,
  taskActivityIds,
} from '../../../src/renderer/utils/agentActivity';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { PermissionRequest } from '../../../src/shared/contract/permission';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { LastToolStep } from '../../../src/shared/contract/backgroundTask';

describe('describeLastToolStep', () => {
  it('uses the existing humanizeToolStep vocabulary when a step exists', () => {
    expect(describeLastToolStep({
      tool: 'Read',
      target: '/repo/spec.md',
      at: 1,
    }, zh)).toBe('读取了 /repo/spec.md');
  });

  it('does not invent activity when no tool step exists', () => {
    expect(describeLastToolStep(undefined, zh)).toBeUndefined();
  });

  it('humanizes agent conversation through the same vocabulary', () => {
    expect(describeLastToolStep({
      tool: 'agent_message',
      target: '研究代理',
      at: 1,
    }, zh)).toBe('正在跟 研究代理 说话');
  });

  // ── N-APPROVAL-PENDING-STATUS-COPY：审批未决/进行中不得落在完成时词形 ──

  it('mail_send zh pending reads as a request, never 发送了', () => {
    const label = describeLastToolStep({ tool: 'mail_send', at: 1 }, zh, 'pending-approval');
    expect(label).toContain('请求');
    expect(label).not.toContain('发送了');
    expect(label).toBe('邮件 · 请求发送邮件');
  });

  it('mail_send zh running reads as in progress', () => {
    const label = describeLastToolStep({ tool: 'mail_send', at: 1 }, zh, 'running');
    expect(label).toContain('正在');
    expect(label).not.toContain('发送了');
    expect(label).toBe('邮件 · 正在发送邮件');
  });

  it('mail_send zh default keeps the completed form unchanged', () => {
    expect(describeLastToolStep({ tool: 'mail_send', at: 1 }, zh)).toBe('邮件 · 发送了邮件');
  });

  it('mail_send en locale: pending / running / default forms', () => {
    expect(describeLastToolStep({ tool: 'mail_send', at: 1 }, en, 'pending-approval'))
      .toBe('Mail · Request to send an email');
    expect(describeLastToolStep({ tool: 'mail_send', at: 1 }, en, 'running'))
      .toBe('Mail · send an email in progress');
    expect(describeLastToolStep({ tool: 'mail_send', at: 1 }, en))
      .toBe('Mail · Sent an email');
  });

  it('reminders_create covers the same variants in zh (second connector write tool)', () => {
    const step: LastToolStep = { tool: 'reminders_create', at: 1 };
    expect(describeLastToolStep(step, zh, 'pending-approval')).toBe('提醒事项 · 请求创建提醒事项');
    expect(describeLastToolStep(step, zh, 'running')).toBe('提醒事项 · 正在创建提醒事项');
    expect(describeLastToolStep(step, zh)).toBe('提醒事项 · 创建了提醒事项');
  });

  it('calendar_create_event covers the en locale variants', () => {
    const step: LastToolStep = { tool: 'calendar_create_event', at: 1 };
    expect(describeLastToolStep(step, en, 'pending-approval')).toBe('Calendar · Request to create an event');
    expect(describeLastToolStep(step, en, 'running')).toBe('Calendar · create an event in progress');
    expect(describeLastToolStep(step, en)).toBe('Calendar · Created an event');
  });
});

// ── N-APPROVAL-PENDING-STATUS-COPY：活动行状态推导（一个 helper，两个消费方共用）──

function mailRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 'perm-1',
    type: 'network',
    tool: 'mail_send',
    agentId: 'task-1',
    details: {},
    timestamp: 1,
    ...overrides,
  };
}

/** 补齐 Task 必填字段，避免不完整对象强转（tsc-tests 棘轮红线）。 */
function taskFixture(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    source: 'delegate_task',
    title: 'delegated write',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    events: [],
    outputRefs: [],
    ...overrides,
  };
}

describe('resolveAgentActivityStepStatus', () => {
  const mailStep: LastToolStep = { tool: 'mail_send', at: 1 };
  const workingTask = { working: true, activityIds: ['task-1'] };

  it('unresolved pending request naming this task flips the connector write to pending-approval', () => {
    expect(resolveAgentActivityStepStatus({
      ...workingTask,
      step: mailStep,
      sessionId: 'session-1',
      permission: {
        pendingPermissionRequest: mailRequest(),
        pendingPermissionSessionId: 'session-1',
        queuedPermissionRequests: {},
      },
    })).toBe('pending-approval');
  });

  it('queued unresolved request for the same session does the same', () => {
    expect(resolveAgentActivityStepStatus({
      ...workingTask,
      step: mailStep,
      sessionId: 'session-1',
      permission: {
        queuedPermissionRequests: { 'session-1': [mailRequest({ id: 'perm-2' })] },
      },
    })).toBe('pending-approval');
  });

  it('correlates through runId as well as task id', () => {
    expect(resolveAgentActivityStepStatus({
      ...workingTask,
      activityIds: ['task-1', 'run-9'],
      step: mailStep,
      sessionId: 'session-1',
      permission: {
        pendingPermissionRequest: mailRequest({ agentId: undefined, runId: 'run-9' }),
        pendingPermissionSessionId: 'session-1',
      },
    })).toBe('pending-approval');
  });

  // 真机形态（N-APPROVAL-PENDING-STATUS-COPY）：delegate_task 的 mail_send 卡不带
  // 顶层 agentId/runId，以 turnOrigin[].runId 指回发起轮（= 任务 id/runId）。
  it('correlates through turnOrigin[].runId when the card names no top-level agentId/runId', () => {
    expect(resolveAgentActivityStepStatus({
      ...workingTask,
      activityIds: ['session-work-1'],
      step: mailStep,
      sessionId: 'session-1',
      permission: {
        pendingPermissionRequest: mailRequest({
          agentId: undefined,
          runId: undefined,
          turnOrigin: [{ senderKind: 'user', sessionId: 'session-1', runId: 'session-work-1', turnId: 't-1' }],
        }),
        pendingPermissionSessionId: 'session-1',
      },
    })).toBe('pending-approval');
  });

  it('turnOrigin naming another run does not flip this row', () => {
    expect(resolveAgentActivityStepStatus({
      ...workingTask,
      step: mailStep,
      sessionId: 'session-1',
      permission: {
        pendingPermissionRequest: mailRequest({
          agentId: undefined,
          runId: undefined,
          turnOrigin: [{ senderKind: 'user', sessionId: 'session-1', runId: 'session-work-other' }],
        }),
        pendingPermissionSessionId: 'session-1',
      },
    })).toBe('running');
  });

  it('resolved request falls through to running for connector writes', () => {
    expect(resolveAgentActivityStepStatus({
      ...workingTask,
      step: mailStep,
      sessionId: 'session-1',
      permission: {
        pendingPermissionRequest: mailRequest({ resolved: true }),
        pendingPermissionSessionId: 'session-1',
      },
    })).toBe('running');
  });

  it('request absent: connector write while the task still works is running', () => {
    expect(resolveAgentActivityStepStatus({
      ...workingTask,
      step: mailStep,
      sessionId: 'session-1',
      permission: { pendingPermissionRequest: null, pendingPermissionSessionId: null },
    })).toBe('running');
    expect(resolveAgentActivityStepStatus({ ...workingTask, step: mailStep })).toBe('running');
  });

  it('request naming another agent or another tool does not hijack this row', () => {
    const otherAgent = {
      ...workingTask,
      step: mailStep,
      sessionId: 'session-1',
      permission: {
        pendingPermissionRequest: mailRequest({ agentId: 'task-other' }),
        pendingPermissionSessionId: 'session-1',
      },
    };
    expect(resolveAgentActivityStepStatus(otherAgent)).toBe('running');
    expect(resolveAgentActivityStepStatus({
      ...otherAgent,
      permission: {
        pendingPermissionRequest: mailRequest({ tool: 'calendar_create_event' }),
        pendingPermissionSessionId: 'session-1',
      },
    })).toBe('running');
  });

  it('pending request parked under another session does not flip this row', () => {
    expect(resolveAgentActivityStepStatus({
      ...workingTask,
      step: mailStep,
      sessionId: 'session-1',
      permission: {
        pendingPermissionRequest: mailRequest(),
        pendingPermissionSessionId: 'session-2',
      },
    })).toBe('running');
  });

  it('read tools keep today wording (out of scope): completed even while working', () => {
    expect(resolveAgentActivityStepStatus({
      ...workingTask,
      step: { tool: 'Read', at: 1 },
      permission: { pendingPermissionRequest: null },
    })).toBe('completed');
  });

  it('terminal target drops back to completed wording for connector writes', () => {
    expect(resolveAgentActivityStepStatus({
      working: false,
      activityIds: ['task-1'],
      step: mailStep,
    })).toBe('completed');
  });

  it('taskActivityIds collects id, runId and metadata.childRunId', () => {
    const task = taskFixture({ id: 'task-1', runId: 'run-9', metadata: { childRunId: 'child-7' } });
    expect(taskActivityIds(task)).toEqual(['task-1', 'run-9', 'child-7']);
    expect(taskActivityIds(taskFixture({ id: 'task-2' }))).toEqual(['task-2']);
  });
});

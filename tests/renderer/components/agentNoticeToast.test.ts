import { describe, expect, it } from 'vitest';
import { formatAgentNoticeToast } from '../../../src/renderer/components/AgentNoticeToast';
import type { AgentNoticeEvent } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

describe('AgentNoticeToast', () => {
  it('formats heartbeat_check_failed with name/error/count substitution in zh and en', () => {
    const event: AgentNoticeEvent = {
      reasonCode: 'heartbeat_check_failed',
      params: { name: 'db-ping', error: 'connection refused', consecutiveFailures: 3 },
    };
    expect(formatAgentNoticeToast(event, zh)).toBe(
      'Heartbeat「db-ping」检查失败：connection refused（连续 3 次）',
    );
    expect(formatAgentNoticeToast(event, en)).toBe(
      'Heartbeat "db-ping" check failed: connection refused (3 in a row)',
    );
  });

  it('formats heartbeat_status_alert with name/status substitution', () => {
    const event: AgentNoticeEvent = {
      reasonCode: 'heartbeat_status_alert',
      params: { name: 'disk-check', status: 'unhealthy' },
    };
    expect(formatAgentNoticeToast(event, zh)).toBe('Heartbeat「disk-check」状态：unhealthy');
    expect(formatAgentNoticeToast(event, en)).toBe('Heartbeat "disk-check" status: unhealthy');
  });

  it('formats auto_agent_awaiting_approval with no params', () => {
    const event: AgentNoticeEvent = { reasonCode: 'auto_agent_awaiting_approval' };
    expect(formatAgentNoticeToast(event, zh)).toBe('任务列表已生成，等待审批');
    expect(formatAgentNoticeToast(event, en)).toBe('Task list generated, awaiting approval');
  });

  it('formats delegate_mode_active with no params', () => {
    const event: AgentNoticeEvent = { reasonCode: 'delegate_mode_active' };
    expect(formatAgentNoticeToast(event, zh)).toBe('Delegate 模式：任务将委派给子 Agent 执行');
    expect(formatAgentNoticeToast(event, en)).toBe(
      'Delegate mode: the task will be handed off to a sub-agent',
    );
  });

  it('formats agent_routed with agentName substitution', () => {
    const event: AgentNoticeEvent = {
      reasonCode: 'agent_routed',
      params: { agentName: 'code-reviewer' },
    };
    expect(formatAgentNoticeToast(event, zh)).toBe('使用 Agent：code-reviewer');
    expect(formatAgentNoticeToast(event, en)).toBe('Using agent: code-reviewer');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';

const infoSpy = vi.fn();
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: infoSpy,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));

const {
  filterToolsByRunPolicy,
  filterToolsByRunPolicyObserved,
  isToolDeniedForRun,
} = await import('../../../src/host/agent/runtime/toolRunPolicy');

const tool = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  requiresPermission: false,
  permissionLevel: 'read',
});

describe('toolRunPolicy', () => {
  it('filters denied tools case-insensitively for a run', () => {
    const ctx = {
      deniedToolNames: ['ask_user_question', 'AskUserQuestion'],
    } as any;

    expect(isToolDeniedForRun(ctx, 'ASK_USER_QUESTION')).toBe(true);
    expect(isToolDeniedForRun(ctx, 'AskUserQuestion')).toBe(true);
    expect(isToolDeniedForRun(ctx, 'bash')).toBe(false);

    expect(filterToolsByRunPolicy([
      tool('AskUserQuestion'),
      tool('bash'),
      tool('ask_user_question'),
    ], ctx).map((item) => item.name)).toEqual(['bash']);
  });

  it('enforces a strict allowlist before a foreground brain can call tools', () => {
    const ctx = {
      allowedToolNames: ['delegate_task', 'task_status', 'AskUserQuestion'],
      deniedToolNames: ['task_status'],
    } as any;

    expect(filterToolsByRunPolicy([
      tool('delegate_task'),
      tool('task_status'),
      tool('AskUserQuestion'),
      tool('bash'),
    ], ctx).map((item) => item.name)).toEqual(['delegate_task', 'AskUserQuestion']);
    expect(isToolDeniedForRun(ctx, 'bash')).toBe(true);
    expect(isToolDeniedForRun(ctx, 'task_status')).toBe(true);
    expect(isToolDeniedForRun(ctx, 'delegate_task')).toBe(false);
  });

  // 2026-08-09 委派入口歧义单：收窄日志只打数量时，「24 -> 9 砍掉了谁」在日志里查不到，
  // 只能翻真库反推。这三条钉住「名字必须打出来」，别再退回纯数量。
  describe('收窄可观测性', () => {
    it('把被剔除的工具名打进日志——数量之外还要点名', () => {
      infoSpy.mockClear();
      const ctx = { allowedToolNames: ['delegate_task', 'Read'] } as any;

      const kept = filterToolsByRunPolicyObserved([
        tool('delegate_task'),
        tool('Read'),
        tool('spawn_agent'),
        tool('workflow_orchestrate'),
      ], ctx);

      expect(kept.map((item) => item.name)).toEqual(['delegate_task', 'Read']);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      // 先钉「日志带了第二个载荷参数」，退回纯数量日志时失败信息直指原因，不是 TypeError。
      expect(infoSpy.mock.calls[0]).toHaveLength(2);
      const [message, payload] = infoSpy.mock.calls[0];
      expect(message).toContain('narrowed 4 -> 2');
      // 承重断言：真机那次真正需要看到的就是这个名字在 removed 里。
      expect(payload.removed).toEqual(['spawn_agent', 'workflow_orchestrate']);
      expect(payload.removedOverflow).toBeUndefined();
    });

    it('剔除数超过上限时截断并报告溢出条数，不静默丢弃', () => {
      infoSpy.mockClear();
      const ctx = { allowedToolNames: ['Read'] } as any;
      const tools = [tool('Read'), ...Array.from({ length: 25 }, (_, i) => tool(`t${i}`))];

      filterToolsByRunPolicyObserved(tools, ctx);

      const payload = infoSpy.mock.calls[0][1];
      expect(payload.removed).toHaveLength(20);
      expect(payload.removed[0]).toBe('t0');
      expect(payload.removedOverflow).toBe(5);
    });

    it('没有收窄时完全静音', () => {
      infoSpy.mockClear();
      filterToolsByRunPolicyObserved([tool('Read')], {} as any);
      expect(infoSpy).not.toHaveBeenCalled();
    });
  });
});

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
  deniedToolRetryGuidance,
} = await import('../../../src/host/agent/runtime/toolRunPolicy');

const tool = (name: string): ToolDefinition => ({
  name,
  description: name,
  outputSchema: { type: 'string' },
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

  it('adds selected connector tools to the run allowlist without weakening explicit denies', () => {
    const ctx = {
      allowedToolNames: ['Read'],
      deniedToolNames: ['tmeetMeetingCreate'],
      toolScope: { allowedConnectorIds: ['tmeet'] },
    } as any;

    expect(filterToolsByRunPolicy([
      tool('Read'),
      tool('Bash'),
      tool('tmeetMeetingList'),
      tool('tmeetMeetingCreate'),
    ], ctx).map((item) => item.name)).toEqual(['Read', 'tmeetMeetingList']);
    expect(isToolDeniedForRun(ctx, 'tmeetMeetingList')).toBe(false);
    expect(isToolDeniedForRun(ctx, 'tmeetMeetingCreate')).toBe(true);
  });

  it('adds tools from selected MCP servers to the run allowlist', () => {
    const ctx = {
      allowedToolNames: ['Read'],
      toolScope: { allowedMcpServerIds: ['github'] },
    } as any;

    expect(filterToolsByRunPolicy([
      tool('Read'),
      tool('mcp__github__search_issues'),
      tool('mcp__slack__search'),
    ], ctx).map((item) => item.name)).toEqual(['Read', 'mcp__github__search_issues']);
  });

  // N-HOME-STARTER-CARDS-FILES r2：前台没有 Bash，文件交付轮看得见 delegate_task 时
  // 模型只会「写脚本 + 派后台」，后台 terminal_write 撞审批卡死，整轮「运行失败」。
  // 收掉委派入口后，工具面上的原生生成工具（docx_generate/excel_generate）成为最短路。
  describe('单轮 Office 文件交付轮的委派面收口', () => {
    const weeklyPrompt = '帮我把这周的工作要点写成一份周报（Word .docx）。请写入一个 .docx 文件，并在回复中说明生成的文件名。不要问我任何问题。';
    const sheetPrompt = 'Analyze this monthly sales dataset and generate an Excel workbook (.xlsx): include a raw-data worksheet and a summary table. Write the workbook to a .xlsx file and state the generated filename in your reply, without asking me any questions.';

    it.each([
      ['zh 周报卡', weeklyPrompt],
      ['en 表格卡', sheetPrompt],
    ])('%s：委派工具被移出，原生生成工具与读写工具保留', (_label, prompt) => {
      const ctx = { messages: [{ role: 'user', content: prompt }] } as any;

      const kept = filterToolsByRunPolicy([
        tool('delegate_task'),
        tool('spawn_agent'),
        tool('workflow'),
        tool('docx_generate'),
        tool('excel_generate'),
        tool('DocEdit'),
        tool('Read'),
        tool('Write'),
      ], ctx).map((item) => item.name);

      expect(kept).toContain('docx_generate');
      expect(kept).toContain('excel_generate');
      expect(kept).toContain('DocEdit');
      expect(kept).toContain('Read');
      expect(kept).toContain('Write');
      expect(kept).not.toContain('delegate_task');
      expect(kept).not.toContain('spawn_agent');
      expect(kept).not.toContain('workflow');
    });

    it('前台白名单 + 文件交付：生成工具进面，委派工具出局（组装末端形状）', () => {
      const ctx = {
        allowedToolNames: [
          'Read', 'Write', 'Edit', 'Glob', 'Grep', 'ListDirectory', 'AskUserQuestion',
          'delegate_task', 'task_status', 'steer_task', 'cancel_task', 'spawn_agent',
          'docx_generate',
        ],
        messages: [{ role: 'user', content: weeklyPrompt }],
      } as any;

      const kept = filterToolsByRunPolicy([
        tool('Read'), tool('Write'), tool('Edit'), tool('AskUserQuestion'),
        tool('delegate_task'), tool('task_status'), tool('steer_task'), tool('cancel_task'),
        tool('spawn_agent'), tool('docx_generate'), tool('Bash'),
      ], ctx).map((item) => item.name);

      expect(kept).toContain('docx_generate');
      expect(kept).toContain('Write');
      expect(kept).not.toContain('delegate_task');
      expect(kept).not.toContain('spawn_agent');
      expect(kept).not.toContain('Bash');
    });

    it.each([
      ['读取已有 docx（无生成动词）保留委派入口', '打开 report.docx 看看结论'],
      ['复杂大型交付保留委派入口', '全面深入地研究这个行业，生成一份完整报告 .docx'],
      ['闲聊保留委派入口', '你好'],
    ])('%s', (_label, prompt) => {
      const ctx = { messages: [{ role: 'user', content: prompt }] } as any;

      expect(filterToolsByRunPolicy([
        tool('delegate_task'),
        tool('Read'),
      ], ctx).map((item) => item.name)).toEqual(['delegate_task', 'Read']);
    });
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

  // issue #1994：headless/管道跑批里 AskUserQuestion 无人应答，白等一轮还触发
  // 问句未答冻结，整轮作废。无人值守轮必须把它收出工具面；有人值守原样保留。
  describe('无人值守轮 AskUserQuestion 收口', () => {
    it('unattendedTurn=true 时两个名字等价形都移出工具面', () => {
      const ctx = { unattendedTurn: true } as any;

      expect(filterToolsByRunPolicy([
        tool('AskUserQuestion'),
        tool('ask_user_question'),
        tool('Read'),
        tool('Bash'),
      ], ctx).map((item) => item.name)).toEqual(['Read', 'Bash']);
    });

    it('无人值守 + 显式白名单也不许把 AskUserQuestion 捞回来', () => {
      const ctx = { unattendedTurn: true, allowedToolNames: ['AskUserQuestion', 'Read'] } as any;

      expect(filterToolsByRunPolicy([
        tool('AskUserQuestion'),
        tool('Read'),
      ], ctx).map((item) => item.name)).toEqual(['Read']);
    });

    it('有人值守轮（unattendedTurn 缺省/false）保留 AskUserQuestion，交互行为不变', () => {
      for (const ctx of [{} as any, { unattendedTurn: false } as any]) {
        expect(filterToolsByRunPolicy([
          tool('AskUserQuestion'),
          tool('Read'),
        ], ctx).map((item) => item.name)).toEqual(['AskUserQuestion', 'Read']);
      }
    });

    it('无人值守收窄也走可观测性日志（点名 removed）', () => {
      infoSpy.mockClear();
      const ctx = { unattendedTurn: true } as any;

      const kept = filterToolsByRunPolicyObserved([
        tool('AskUserQuestion'),
        tool('Read'),
      ], ctx);

      expect(kept.map((item) => item.name)).toEqual(['Read']);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const [message, payload] = infoSpy.mock.calls[0];
      expect(message).toContain('narrowed 2 -> 1');
      expect(payload.removed).toEqual(['AskUserQuestion']);
    });

    // ai-review PR#2009：无人值守时重试指引不许再把模型引回已移除的 AskUserQuestion。
    it('无人值守时 deniedToolRetryGuidance 不再声称 AskUserQuestion 可用', () => {
      expect(deniedToolRetryGuidance({ unattendedTurn: true } as any))
        .toContain('state the blocker in your final text');
      expect(deniedToolRetryGuidance({ unattendedTurn: true } as any))
        .not.toContain('AskUserQuestion remains available');
      // 有人值守且无显式 deny：指引保持旧行为。
      expect(deniedToolRetryGuidance({} as any))
        .toContain('AskUserQuestion remains available');
    });
  });
});

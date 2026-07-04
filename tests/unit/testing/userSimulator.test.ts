// ============================================================================
// 批 6 · B6a：规则式 user simulator 纯函数引擎
// ============================================================================
// 确定性（非 LLM）模拟用户：按 agent 上一轮输出/工具调用匹配条件应答规则，
// 覆盖审批门/澄清卡三分支（批准/拒绝/改需求）。
// fail-loud 口径（承接批 3）：非法规则显式报错，不静默跳过。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  buildPermissionDecider,
  evaluateSimRules,
  validateUserSimulation,
  WRITE_EFFECT_TOOL_PATTERNS,
} from '../../../src/host/testing/userSimulator';
import type { ToolExecutionRecord, UserSimulation } from '../../../src/host/testing/types';

function toolExec(tool: string, overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tool,
    input: {},
    output: '',
    success: true,
    duration: 1,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('validateUserSimulation', () => {
  it('accepts a minimal valid three-branch simulation', () => {
    const sim: UserSimulation = {
      rules: [
        { id: 'approve', when: { question_asked: true }, respond: '批准，继续执行' },
        { id: 'reject', when: { response_matches: '继续吗' }, respond: '不批准，停止', stop: true },
        { id: 'change', when: { tool_called: 'AskUserQuestion' }, respond: '改成方案 B' },
      ],
    };
    expect(validateUserSimulation(sim)).toBeNull();
  });

  it('rejects empty rules array', () => {
    expect(validateUserSimulation({ rules: [] })).toMatch(/rules/);
  });

  it('rejects a rule with neither respond nor stop', () => {
    const sim = { rules: [{ id: 'r1', when: { question_asked: true } }] } as UserSimulation;
    expect(validateUserSimulation(sim)).toMatch(/respond|stop/);
  });

  it('rejects a rule with empty when (would match everything silently)', () => {
    const sim = { rules: [{ id: 'r1', when: {}, respond: 'ok' }] } as UserSimulation;
    expect(validateUserSimulation(sim)).toMatch(/when/);
  });

  it('rejects invalid regex in response_matches (fail-loud, not silent skip)', () => {
    const sim = {
      rules: [{ id: 'r1', when: { response_matches: '([' }, respond: 'ok' }],
    } as UserSimulation;
    expect(validateUserSimulation(sim)).toMatch(/regex|invalid/i);
  });

  it('rejects duplicate rule ids', () => {
    const sim = {
      rules: [
        { id: 'dup', when: { question_asked: true }, respond: 'a' },
        { id: 'dup', when: { question_asked: true }, respond: 'b' },
      ],
    } as UserSimulation;
    expect(validateUserSimulation(sim)).toMatch(/dup/);
  });

  it('rejects non-positive max_turns', () => {
    const sim = {
      max_turns: 0,
      rules: [{ id: 'r1', when: { question_asked: true }, respond: 'ok' }],
    } as UserSimulation;
    expect(validateUserSimulation(sim)).toMatch(/max_turns/);
  });

  it('rejects unknown permission_policy value', () => {
    const sim = {
      permission_policy: 'maybe',
      rules: [{ id: 'r1', when: { question_asked: true }, respond: 'ok' }],
    } as unknown as UserSimulation;
    expect(validateUserSimulation(sim)).toMatch(/permission_policy/);
  });
});

describe('evaluateSimRules', () => {
  const baseSim: UserSimulation = {
    rules: [
      { id: 'approve', when: { question_asked: true, response_matches: '可以开始吗' }, respond: '批准' },
      { id: 'fallback', when: { response_matches: '任何问题' }, respond: '没问题' },
    ],
  };

  it('matches question_asked via AskUserQuestion tool execution', () => {
    const match = evaluateSimRules(
      { rules: [{ id: 'q', when: { question_asked: true }, respond: '批准' }] },
      { responses: ['我需要确认'], toolExecutions: [toolExec('AskUserQuestion')] },
      new Map(),
    );
    expect(match?.rule.id).toBe('q');
    expect(match?.action).toBe('respond');
    expect(match?.message).toBe('批准');
  });

  it('does not match question_asked when no AskUserQuestion call happened', () => {
    const match = evaluateSimRules(
      { rules: [{ id: 'q', when: { question_asked: true }, respond: '批准' }] },
      { responses: ['直接干完了'], toolExecutions: [toolExec('Write')] },
      new Map(),
    );
    expect(match).toBeNull();
  });

  it('matches response_matches as case-insensitive regex over last-turn responses', () => {
    const match = evaluateSimRules(
      { rules: [{ id: 'r', when: { response_matches: 'PROCEED\\?' }, respond: 'yes' }] },
      { responses: ['Shall I proceed?'], toolExecutions: [] },
      new Map(),
    );
    expect(match?.rule.id).toBe('r');
  });

  it('matches tool_called as regex over last-turn tool names', () => {
    const match = evaluateSimRules(
      { rules: [{ id: 't', when: { tool_called: '^Ask' }, respond: 'ok' }] },
      { responses: [], toolExecutions: [toolExec('AskUserQuestion')] },
      new Map(),
    );
    expect(match?.rule.id).toBe('t');
  });

  it('requires ALL given conditions (AND semantics)', () => {
    const match = evaluateSimRules(
      baseSim,
      // question_asked 满足但 response_matches 不满足 → approve 不命中
      { responses: ['别的话'], toolExecutions: [toolExec('AskUserQuestion')] },
      new Map(),
    );
    expect(match).toBeNull();
  });

  it('first matching rule wins (declaration order)', () => {
    const sim: UserSimulation = {
      rules: [
        { id: 'first', when: { response_matches: '确认' }, respond: 'a' },
        { id: 'second', when: { response_matches: '确认' }, respond: 'b' },
      ],
    };
    const match = evaluateSimRules(sim, { responses: ['请确认'], toolExecutions: [] }, new Map());
    expect(match?.rule.id).toBe('first');
  });

  it('enforces max_matches (default 1) to prevent infinite loops', () => {
    const sim: UserSimulation = {
      rules: [{ id: 'once', when: { response_matches: '继续' }, respond: 'go' }],
    };
    const counts = new Map<string, number>();
    const ctx = { responses: ['继续吗？'], toolExecutions: [] };
    expect(evaluateSimRules(sim, ctx, counts)?.rule.id).toBe('once');
    expect(evaluateSimRules(sim, ctx, counts)).toBeNull();
  });

  it('honors explicit max_matches > 1', () => {
    const sim: UserSimulation = {
      rules: [{ id: 'twice', when: { response_matches: '继续' }, respond: 'go', max_matches: 2 }],
    };
    const counts = new Map<string, number>();
    const ctx = { responses: ['继续吗？'], toolExecutions: [] };
    expect(evaluateSimRules(sim, ctx, counts)?.rule.id).toBe('twice');
    expect(evaluateSimRules(sim, ctx, counts)?.rule.id).toBe('twice');
    expect(evaluateSimRules(sim, ctx, counts)).toBeNull();
  });

  it('returns stop action for stop-only rules (reject branch: user refuses, no reply)', () => {
    const sim: UserSimulation = {
      rules: [{ id: 'refuse', when: { question_asked: true }, stop: true }],
    };
    const match = evaluateSimRules(
      sim,
      { responses: ['可以吗'], toolExecutions: [toolExec('AskUserQuestion')] },
      new Map(),
    );
    expect(match?.action).toBe('stop');
    expect(match?.message).toBeUndefined();
  });

  it('respond + stop: replies once then conversation ends', () => {
    const sim: UserSimulation = {
      rules: [{ id: 'reject', when: { question_asked: true }, respond: '不批准，停止', stop: true }],
    };
    const match = evaluateSimRules(
      sim,
      { responses: ['可以吗'], toolExecutions: [toolExec('AskUserQuestion')] },
      new Map(),
    );
    expect(match?.action).toBe('respond');
    expect(match?.message).toBe('不批准，停止');
    expect(match?.rule.stop).toBe(true);
  });
});

describe('buildPermissionDecider', () => {
  it('returns null when no permission_policy configured (keep default auto-approve)', () => {
    expect(
      buildPermissionDecider({ rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }] }),
    ).toBeNull();
  });

  it('approve policy approves everything', () => {
    const decider = buildPermissionDecider({
      permission_policy: 'approve',
      rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }],
    });
    expect(decider?.({ toolName: 'Write' })).toBe(true);
    expect(decider?.({ toolName: 'Bash' })).toBe(true);
  });

  it('reject policy rejects everything by default', () => {
    const decider = buildPermissionDecider({
      permission_policy: 'reject',
      rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }],
    });
    expect(decider?.({ toolName: 'Write' })).toBe(false);
  });

  it('reject policy with permission_reject_tools only rejects matching tools', () => {
    const decider = buildPermissionDecider({
      permission_policy: 'reject',
      permission_reject_tools: ['^Write$'],
      rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }],
    });
    expect(decider?.({ toolName: 'Write' })).toBe(false);
    expect(decider?.({ toolName: 'Read' })).toBe(true);
  });
});

describe('WRITE_EFFECT_TOOL_PATTERNS', () => {
  it('covers core write-effect tools and spares read-only tools', () => {
    const isWriteEffect = (tool: string) =>
      WRITE_EFFECT_TOOL_PATTERNS.some((p) => new RegExp(p).test(tool));
    for (const tool of ['Write', 'Edit', 'Append', 'Bash', 'git_commit', 'docx_generate']) {
      expect(isWriteEffect(tool), `${tool} should count as write-effect`).toBe(true);
    }
    for (const tool of ['Read', 'Grep', 'Glob', 'ListDirectory', 'attempt_completion', 'AskUserQuestion']) {
      expect(isWriteEffect(tool), `${tool} should NOT count as write-effect`).toBe(false);
    }
  });
});

// ============================================================================
// 连续整轮失败守卫（N-INFER-HANG-SPIN）
//
// 五轮全部真实失败 → force-final reason failed-round-guard。
// 成功清零；并行多失败只计一轮；skipped / undefined 中性；已有 reason 不覆盖。
// CODE_AGENT_FAILED_ROUND_GUARD=0 关闭。反向变异：按调用计数、去掉成功清零，本文件变红。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { FAILED_ROUND_GUARD } from '../../../src/shared/constants/circuitBreaker';
import { observeFailedToolRound } from '../../../src/host/agent/toolExecution/failedRoundGuard';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { shouldDeferForcedFinalToInference } from '../../../src/host/agent/runtime/messageProcessorHelpers';

const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  }),
}));

const DISABLE_ENV = FAILED_ROUND_GUARD.DISABLE_ENV;

function makeCtx(control = ControlState.forTest()): { ctx: RuntimeContext; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn();
  const ctx = {
    control,
    turnTrace: { record },
  } as unknown as RuntimeContext;
  return { ctx, record };
}

function call(id: string, name: string): ToolCall {
  return { id, name, arguments: {} };
}

function fail(id: string, error: string): ToolResult {
  return { toolCallId: id, success: false, error };
}

function ok(id: string): ToolResult {
  return { toolCallId: id, success: true, output: 'ok' };
}

function skipped(id: string, error = 'skipped'): ToolResult {
  return { toolCallId: id, success: false, error, metadata: { skipped: true } };
}

function failRound(
  ctx: RuntimeContext,
  name: string,
  error: string,
  index: number,
): void {
  observeFailedToolRound(
    ctx,
    [call(`${name}-${index}`, name)],
    [fail(`${name}-${index}`, error)],
  );
}

describe('failed-round guard', () => {
  const previous = process.env[DISABLE_ENV];

  afterEach(() => {
    warn.mockClear();
    if (previous === undefined) delete process.env[DISABLE_ENV];
    else process.env[DISABLE_ENV] = previous;
  });

  it('keeps the default of 5 consecutive rounds beside the circuit-breaker constants', () => {
    expect(FAILED_ROUND_GUARD.MAX_CONSECUTIVE_FAILED_ROUNDS).toBe(5);
    expect(FAILED_ROUND_GUARD.DISABLE_ENV).toBe('CODE_AGENT_FAILED_ROUND_GUARD');
  });

  it('five consecutive all-failed rounds set failed-round-guard with an explanation prompt', () => {
    const { ctx, record } = makeCtx();
    for (let index = 1; index <= 4; index += 1) {
      failRound(ctx, 'convert_pdf', `round-${index}-marker soffice missing`, index);
      expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    }
    failRound(ctx, 'convert_pdf', `round-5-marker soffice missing`, 5);

    expect(ctx.control.forceFinalResponseReason).toBe('failed-round-guard');
    const prompt = ctx.control.forceFinalResponsePrompt ?? '';
    expect(prompt).toContain('<force-final-response reason="failed-round-guard">');
    expect(prompt).toContain('stopped further tool use because the last 5 rounds failed entirely');
    expect(prompt).toContain('convert_pdf');
    expect(prompt).toContain('round-5-marker soffice missing');
    expect(prompt).toContain('round-4-marker soffice missing');
    expect(prompt).toContain('round-3-marker soffice missing');
    expect(prompt).not.toContain('round-1-marker');
    expect(prompt).not.toContain('round-2-marker');
    expect(prompt).toContain('Say what was attempted, what failed, and why in plain prose.');
    expect(prompt).toContain('State clearly whether any deliverable file exists.');
    expect(prompt).toContain('Do not claim success.');
    expect(prompt).not.toContain('<tool_call');
    expect(prompt).not.toContain('<longcat_tool_call');
    expect(shouldDeferForcedFinalToInference(ctx)).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('failed_round_guard', {
      rounds: 5,
      toolNames: ['convert_pdf', 'convert_pdf', 'convert_pdf', 'convert_pdf', 'convert_pdf'],
    });
    expect(warn).toHaveBeenCalledTimes(1);

    ctx.control.clearForceFinalResponse();
    failRound(ctx, 'convert_pdf', 'after-reset', 6);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('cuts each of at most three error lines to 200 characters', () => {
    const { ctx } = makeCtx();
    const longError = `tail ${'Y'.repeat(400)}`;
    for (let index = 1; index <= 4; index += 1) failRound(ctx, 'bash', `early-${index}`, index);
    observeFailedToolRound(
      ctx,
      [call('a', 'bash'), call('b', 'libreoffice_convert'), call('c', 'convert_pdf'), call('d', 'soffice')],
      [
        fail('a', 'drop-me'),
        fail('b', longError),
        fail('c', 'visible-c'),
        fail('d', 'visible-d'),
      ],
    );
    const prompt = ctx.control.forceFinalResponsePrompt ?? '';
    const errorLines = prompt.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2));
    expect(errorLines).toHaveLength(3);
    expect(errorLines.join('\n')).not.toContain('drop-me');
    expect(errorLines.join('\n')).not.toContain('Y'.repeat(201));
    for (const line of errorLines) expect(line.length).toBeLessThanOrEqual(200);
    expect(prompt).toContain('visible-c');
    expect(prompt).toContain('visible-d');
  });

  it('four failed rounds then one success resets so a later failure does not trip', () => {
    const { ctx, record } = makeCtx();
    for (let index = 1; index <= 4; index += 1) failRound(ctx, 'bash', `fail-${index}`, index);
    observeFailedToolRound(ctx, [call('ok', 'bash')], [ok('ok')]);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    failRound(ctx, 'bash', 'after-success', 5);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a parallel round of five failed calls counts as one round and does not trip', () => {
    const { ctx } = makeCtx();
    const calls = [1, 2, 3, 4, 5].map((index) => call(`p-${index}`, 'bash'));
    const results = calls.map((toolCall) => fail(toolCall.id, 'exit 1'));
    observeFailedToolRound(ctx, calls, results);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });

  it('a parallel round of three failed calls counts once and five such rounds trip', () => {
    const { ctx, record } = makeCtx();
    for (let round = 1; round <= 5; round += 1) {
      const calls = [1, 2, 3].map((index) => call(`r${round}-${index}`, index === 1 ? 'bash' : 'convert_pdf'));
      observeFailedToolRound(ctx, calls, calls.map((toolCall) => fail(toolCall.id, `exit ${round}`)));
      if (round < 5) expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    }
    expect(ctx.control.forceFinalResponseReason).toBe('failed-round-guard');
    expect(record).toHaveBeenCalledTimes(1);
    const payload = record.mock.calls[0]?.[1] as { rounds: number; toolNames: string[] };
    expect(payload.rounds).toBe(5);
    expect(payload.toolNames.filter((name) => name === 'bash')).toHaveLength(5);
  });

  it('a skipped-only round is neutral and keeps the streak', () => {
    const { ctx } = makeCtx();
    for (let index = 1; index <= 4; index += 1) failRound(ctx, 'bash', `fail-${index}`, index);
    observeFailedToolRound(ctx, [call('skip', 'bash')], [skipped('skip')]);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    failRound(ctx, 'bash', 'fifth-real', 5);
    expect(ctx.control.forceFinalResponseReason).toBe('failed-round-guard');
  });

  it('a round with any undefined result is neutral', () => {
    const { ctx } = makeCtx();
    for (let index = 1; index <= 4; index += 1) failRound(ctx, 'bash', `fail-${index}`, index);
    observeFailedToolRound(
      ctx,
      [call('done', 'bash'), call('never', 'bash')],
      [fail('done', 'exit 1'), undefined],
    );
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    observeFailedToolRound(ctx, [call('only-hole', 'bash')], [undefined]);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    failRound(ctx, 'bash', 'fifth-real', 5);
    expect(ctx.control.forceFinalResponseReason).toBe('failed-round-guard');
  });

  it('counts a real failure even when the same round also has a skipped result', () => {
    const { ctx } = makeCtx();
    for (let round = 1; round <= 5; round += 1) {
      observeFailedToolRound(
        ctx,
        [call(`f-${round}`, 'bash'), call(`s-${round}`, 'bash')],
        [fail(`f-${round}`, 'exit 1'), skipped(`s-${round}`)],
      );
    }
    expect(ctx.control.forceFinalResponseReason).toBe('failed-round-guard');
  });

  it('any success in the round resets even if another call failed', () => {
    const { ctx } = makeCtx();
    for (let index = 1; index <= 4; index += 1) failRound(ctx, 'bash', `fail-${index}`, index);
    observeFailedToolRound(
      ctx,
      [call('bad', 'bash'), call('good', 'write')],
      [fail('bad', 'exit 1'), ok('good')],
    );
    failRound(ctx, 'bash', 'after-mixed-success', 5);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });

  it('does not override an existing force-final reason', () => {
    const control = ControlState.forTest({
      forceFinalResponseReason: 'goal-impossible',
      forceFinalResponsePrompt: 'keep-existing-prompt',
    });
    const { ctx, record } = makeCtx(control);
    for (let index = 1; index <= 6; index += 1) failRound(ctx, 'bash', `fail-${index}`, index);
    expect(ctx.control.forceFinalResponseReason).toBe('goal-impossible');
    expect(ctx.control.forceFinalResponsePrompt).toBe('keep-existing-prompt');
    expect(record).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('CODE_AGENT_FAILED_ROUND_GUARD=0 never trips over 20 all-failed rounds and is read at call time', () => {
    const { ctx, record } = makeCtx();
    process.env[DISABLE_ENV] = '0';
    for (let index = 1; index <= 20; index += 1) failRound(ctx, 'bash', `fail-${index}`, index);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    delete process.env[DISABLE_ENV];
    for (let index = 1; index <= 5; index += 1) failRound(ctx, 'bash', `live-${index}`, index);
    expect(ctx.control.forceFinalResponseReason).toBe('failed-round-guard');
  });
});

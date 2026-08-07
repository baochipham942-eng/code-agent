// ============================================================================
// A3 分支测试：全局记忆写入确认失败要区分「超时」与「用户明确拒绝」，
// 两种情况的 error 文案必须不同——用户点了「拒绝」和「没看见弹窗」需要的
// 下一步完全不一样。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const broadcast = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/platform/windowBridge', () => ({
  broadcastToRenderer: broadcast,
}));

import {
  clearDirectiveMemoryConfirmationsForTest,
  requestDirectiveMemoryConfirmation,
  respondToDirectiveMemoryConfirmation,
} from '../../../src/host/memory/directiveMemoryConfirmation';
import {
  DIRECTIVE_MEMORY_CONFIRMATION_DECLINED_ERROR,
  DIRECTIVE_MEMORY_CONFIRMATION_TIMEOUT_ERROR,
  DIRECTIVE_MEMORY_WRITE_NO_GRANT_ERROR,
  directiveMemoryConfirmationFailureError,
} from '../../../src/host/memory/directiveMemoryMessages';
import { MEMORY_TIMEOUTS } from '../../../src/shared/constants';
import type { MemoryConfirmRequest } from '../../../src/shared/contract/memory';

function captureRequest(): MemoryConfirmRequest {
  expect(broadcast).toHaveBeenCalledOnce();
  return broadcast.mock.calls[0][1] as MemoryConfirmRequest;
}

describe('requestDirectiveMemoryConfirmation — 超时与拒绝要可区分', () => {
  beforeEach(() => {
    broadcast.mockClear();
  });

  afterEach(() => {
    clearDirectiveMemoryConfirmationsForTest();
    vi.useRealTimers();
  });

  it('120 秒无响应：confirmed=false 且带 timedOut 标记', async () => {
    vi.useFakeTimers();
    const pending = requestDirectiveMemoryConfirmation({ content: 'x', category: 'y' });
    captureRequest();

    await vi.advanceTimersByTimeAsync(MEMORY_TIMEOUTS.DIRECTIVE_CONFIRM);
    const result = await pending;

    expect(result.confirmed).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('用户在窗口里点拒绝：confirmed=false 且 timedOut=false', async () => {
    const pending = requestDirectiveMemoryConfirmation({ content: 'x', category: 'y' });
    const request = captureRequest();

    expect(respondToDirectiveMemoryConfirmation(request.id, false)).toBe(true);
    const result = await pending;

    expect(result.confirmed).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('用户在窗口里点确认：confirmed=true 且 timedOut=false', async () => {
    const pending = requestDirectiveMemoryConfirmation({ content: 'x', category: 'y' });
    const request = captureRequest();

    expect(respondToDirectiveMemoryConfirmation(request.id, true)).toBe(true);
    const result = await pending;

    expect(result.confirmed).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});

describe('directiveMemoryConfirmationFailureError — 超时/拒绝文案分流', () => {
  it('超时与拒绝产生不同的 error 文案', () => {
    // 签名是 Pick<DirectiveMemoryConfirmationResult, 'timedOut'>——只读这一个字段，
    // 传完整结果对象会触发对象字面量的多余属性检查（TS2353）。按签名给最小入参。
    const timeoutError = directiveMemoryConfirmationFailureError({ timedOut: true });
    const declinedError = directiveMemoryConfirmationFailureError({ timedOut: false });

    expect(timeoutError).toBe(DIRECTIVE_MEMORY_CONFIRMATION_TIMEOUT_ERROR);
    expect(declinedError).toBe(DIRECTIVE_MEMORY_CONFIRMATION_DECLINED_ERROR);
    expect(timeoutError).not.toBe(declinedError);
  });

  it('三条文案互不相同，且各自回答「发生了什么/为什么/现在能做什么」', () => {
    const all = [
      DIRECTIVE_MEMORY_CONFIRMATION_TIMEOUT_ERROR,
      DIRECTIVE_MEMORY_CONFIRMATION_DECLINED_ERROR,
      DIRECTIVE_MEMORY_WRITE_NO_GRANT_ERROR,
    ];
    expect(new Set(all).size).toBe(3);
    for (const text of all) {
      // 为什么：全局记忆影响之后所有会话，必须用户本人同意
      expect(text).toContain('全局记忆');
      // 现在能做什么 + 给模型的行动指引（不要盲目重试）
      expect(text).toContain('模型');
    }
  });

  it('超时文案说清「等了很久没响应」，拒绝文案说清「被拒绝」', () => {
    expect(DIRECTIVE_MEMORY_CONFIRMATION_TIMEOUT_ERROR).toContain('没有等到响应');
    expect(DIRECTIVE_MEMORY_CONFIRMATION_DECLINED_ERROR).toContain('拒绝');
  });
});

import { describe, expect, it } from 'vitest';
import { HostReasonCode } from '../../src/shared/contract';
import { zh } from '../../src/renderer/i18n/zh';
import { en } from '../../src/renderer/i18n/en';

describe('goal abort i18n registry', () => {
  it('所有 goal-abort code 都有 zh/en 人话，且不把技术数值写进公开文案', () => {
    const codes = [
      HostReasonCode.GoalAbortRuntimeFailure,
      HostReasonCode.GoalAbortTurnLimit,
      HostReasonCode.GoalAbortTokenBudget,
      HostReasonCode.GoalAbortTimeBudget,
      HostReasonCode.GoalAbortUnreachable,
      HostReasonCode.GoalAbortRepeatedAction,
    ];

    for (const code of codes) {
      expect(zh.agentError.hostReasons[code].summary).toBeTruthy();
      expect(en.agentError.hostReasons[code].summary).toBeTruthy();
      expect(JSON.stringify(zh.agentError.hostReasons[code])).not.toMatch(/\d+\s*轮|\d+\s*token/i);
    }
  });
});

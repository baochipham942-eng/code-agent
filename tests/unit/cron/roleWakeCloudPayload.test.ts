import { describe, expect, it } from 'vitest';
import { validateRoleWakeCloudPayload } from '../../../src/host/cron/roleWakeCloudPayload';
import { ROLE_PROACTIVITY } from '../../../src/shared/constants/memory';
import { isExternalSideEffectTool } from '../../../src/host/tools/externalSideEffect';

// 生产接线（cronApiClient.actionToCronApiPayload）用的同款只读谓词：
// 「只读」= 不是对外可见副作用工具（externalSideEffect.ts 的判据，
// resolveWakeRunToolScope 丢对外副作用工具用的就是它）。
const readOnlyByExternalSideEffect = (toolName: string) => !isExternalSideEffectTool(toolName);

function validInput() {
  return {
    roleId: 'role-analyst',
    environmentId: 'env-prod',
    readOnlyToolScope: ['webSearch', 'read_file'],
    maxWakesPerDay: ROLE_PROACTIVITY.MAX_WAKES_PER_DAY,
    isToolReadOnly: readOnlyByExternalSideEffect,
  };
}

describe('validateRoleWakeCloudPayload', () => {
  it('accepts a complete draft payload and returns it unchanged in shape', () => {
    const input = validInput();
    const result = validateRoleWakeCloudPayload(input);
    expect(result).toEqual({
      ok: true,
      payload: {
        kind: 'roleWake',
        roleId: 'role-analyst',
        environmentId: 'env-prod',
        readOnlyToolScope: ['webSearch', 'read_file'],
        maxWakesPerDay: ROLE_PROACTIVITY.MAX_WAKES_PER_DAY,
      },
    });
  });

  it('accepts maxWakesPerDay exactly at the cap (boundary)', () => {
    const result = validateRoleWakeCloudPayload({
      ...validInput(),
      maxWakesPerDay: ROLE_PROACTIVITY.MAX_WAKES_PER_DAY,
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['blank string', '   '],
  ])('rejects roleId=%s with missing-role-id', (_label, roleId) => {
    const result = validateRoleWakeCloudPayload({ ...validInput(), roleId });
    expect(result).toEqual({ ok: false, reason: 'missing-role-id' });
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['blank string', ' \t '],
  ])('rejects environmentId=%s with missing-environment-id', (_label, environmentId) => {
    const result = validateRoleWakeCloudPayload({ ...validInput(), environmentId });
    expect(result).toEqual({ ok: false, reason: 'missing-environment-id' });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects maxWakesPerDay=%s with invalid-max-wakes', (_label, maxWakesPerDay) => {
    const result = validateRoleWakeCloudPayload({ ...validInput(), maxWakesPerDay });
    expect(result).toEqual({ ok: false, reason: 'invalid-max-wakes' });
  });

  it('rejects maxWakesPerDay above ROLE_PROACTIVITY.MAX_WAKES_PER_DAY with max-wakes-exceeds-cap', () => {
    const result = validateRoleWakeCloudPayload({
      ...validInput(),
      maxWakesPerDay: ROLE_PROACTIVITY.MAX_WAKES_PER_DAY + 1,
    });
    expect(result).toEqual({ ok: false, reason: 'max-wakes-exceeds-cap' });
  });

  it('rejects an external side-effect tool in the scope with non-read-only-tool and names it', () => {
    const result = validateRoleWakeCloudPayload({
      ...validInput(),
      readOnlyToolScope: ['webSearch', 'mail_send'],
    });
    expect(result).toEqual({ ok: false, reason: 'non-read-only-tool', toolName: 'mail_send' });
  });

  it('rejects messaging-MCP send tools as non-read-only via the repo predicate', () => {
    const result = validateRoleWakeCloudPayload({
      ...validInput(),
      readOnlyToolScope: ['mcp__slack__chat_postMessage'],
    });
    expect(result).toEqual({
      ok: false,
      reason: 'non-read-only-tool',
      toolName: 'mcp__slack__chat_postMessage',
    });
  });

  it('takes the read-only judgement from the predicate argument, not a baked-in list', () => {
    // 换一个严格白名单谓词：webSearch 只读、exec 不只读——证明判定全由入参决定。
    const result = validateRoleWakeCloudPayload({
      ...validInput(),
      readOnlyToolScope: ['webSearch', 'exec'],
      isToolReadOnly: (toolName) => toolName === 'webSearch',
    });
    expect(result).toEqual({ ok: false, reason: 'non-read-only-tool', toolName: 'exec' });
  });
});

import { describe, expect, it } from 'vitest';
import { buildCronAgentActionResult } from '../../../src/host/cron/cronNormalizers';
import { parseStatedEventDecisions, settleEventRunDecisions } from '../../../src/host/cron/cronEventDecisions';
import type { CronEventActionMode } from '../../../src/shared/contract/cron';

const NOTICE = 'om_x100b61bf71a644a4b4f14c9f051a368';
const NOTICE_SLIPPED = `${NOTICE}f`;
const CHAT = 'om_x100b61bf711bf0a4cd0c51f313b268f';

function settle(mode: CronEventActionMode, text: string | null, carried: string[] = [NOTICE, CHAT], rawResult?: unknown) {
  const result = rawResult !== undefined
    ? rawResult
    : { ...buildCronAgentActionResult({ agentType: 'a', prompt: 'p' }, undefined, 's', text ?? '', false), ...(text !== null && parseStatedEventDecisions(text).length > 0 ? { eventDecisions: parseStatedEventDecisions(text) } : {}) };
  return settleEventRunDecisions({
    jobId: 'j',
    mode,
    carriedEventIds: carried,
    dropped: [],
    execution: { id: 'r1', status: 'completed', result },
    observeActionCount: () => 0,
  });
}
const tag = (id: string, action: string, reason = 'r') => `<cron_event_decision id="${id}" action="${action}">${reason}</cron_event_decision>`;

describe('cron event decision id matching', () => {
  it('exact ids unchanged', () => {
    const rows = settle('auto', tag(NOTICE, 'act') + tag(CHAT, 'ignore'));
    expect(rows.map((r) => r.decision)).toEqual(['acted', 'ignored']);
  });

  it('model appended an extra char to a long id → still acted / would_act', () => {
    const text = tag(NOTICE_SLIPPED, 'act', 'release notice') + tag(CHAT, 'ignore');
    expect(settle('auto', text).map((r) => r.decision)).toEqual(['acted', 'ignored']);
    const observe = settle('observe', text);
    expect(observe[0].decision).toBe('would_act');
    expect(observe[0].reason).toBe('release notice');
  });

  it('ambiguous prefix → fallback', () => {
    const rows = settle('observe', tag(NOTICE_SLIPPED, 'act'), [NOTICE, `${NOTICE_SLIPPED}0`]);
    expect(rows.map((r) => r.decision)).toEqual(['ignored', 'ignored']);
    const two = settle('observe', tag(`${NOTICE}a`, 'act') + tag(`${NOTICE}b`, 'act'), [NOTICE]);
    expect(two[0].decision).toBe('ignored');
  });

  it('unmatched ignore stays ignored', () => {
    expect(settle('auto', tag(NOTICE_SLIPPED, 'ignore'))[0].decision).toBe('ignored');
  });

  it('fallback reasons: nothing stated / ids did not match / no field', () => {
    const none = settle('observe', 'done')[0].reason;
    const mismatch = settle('observe', tag('om_zzz', 'act'))[0].reason;
    const noField = settle('observe', null, [NOTICE], 'plain string')[0].reason;
    expect(none).toBe('no outbound action attempted (no per-event reason stated)');
    expect(mismatch).toContain('om_zzz');
    expect(noField).toContain('run result carried no eventDecisions field');
    expect(new Set([none, mismatch, noField]).size).toBe(3);
  });
});

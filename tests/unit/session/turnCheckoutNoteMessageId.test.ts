import { describe, expect, it } from 'vitest';
import { turnCheckoutNoteMessageId } from '../../../src/shared/contract/turnCheckout';

describe('turnCheckoutNoteMessageId', () => {
  it('同一会话稳定，跨会话不撞车——结果卡替换不堆叠靠这个 id upsert', () => {
    expect(turnCheckoutNoteMessageId('sess-a')).toBe('turn-checkout-note:sess-a');
    expect(turnCheckoutNoteMessageId('sess-a')).toBe(turnCheckoutNoteMessageId('sess-a'));
    expect(turnCheckoutNoteMessageId('sess-b')).not.toBe(turnCheckoutNoteMessageId('sess-a'));
  });
});

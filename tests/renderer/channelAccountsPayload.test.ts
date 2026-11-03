import { describe, it, expect } from 'vitest';
import { normalizeChannelAccountsPayload } from '../../src/renderer/components/features/settings/tabs/channelAccountsPayload';

const acc = (id: string) => ({ id, name: id, type: 'telegram', status: 'connected' });

describe('normalizeChannelAccountsPayload', () => {
  it('no args -> []', () => {
    expect(normalizeChannelAccountsPayload()).toEqual([]);
  });
  it.each([0, 1, 3])('single-array form (native bridge) with %i accounts', (n) => {
    const list = Array.from({ length: n }, (_, i) => acc(`a${i}`));
    expect(normalizeChannelAccountsPayload(list)).toEqual(list);
  });
  it('SSE-spread form: 0 accounts arrives as a lone undefined', () => {
    expect(normalizeChannelAccountsPayload(undefined)).toEqual([]);
  });
  it.each([1, 3])('SSE-spread form with %i accounts', (n) => {
    const list = Array.from({ length: n }, (_, i) => acc(`a${i}`));
    expect(normalizeChannelAccountsPayload(...list)).toEqual(list);
  });
  it('drops non-object entries', () => {
    expect(normalizeChannelAccountsPayload(acc('a'), undefined, null, 'x', acc('b'))).toEqual([acc('a'), acc('b')]);
  });
});

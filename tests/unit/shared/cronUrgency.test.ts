import { describe, expect, it } from 'vitest';
import { isCronUrgency, parseUrgencyHeader } from '../../../src/shared/cronUrgency';

describe('parseUrgencyHeader', () => {
  it('reads each of the three valid tiers from the first line', () => {
    expect(parseUrgencyHeader('urgency: must_today\n发票今天到期')).toEqual({ urgency: 'must_today' });
    expect(parseUrgencyHeader('urgency: can_wait\n周报汇总')).toEqual({ urgency: 'can_wait' });
    expect(parseUrgencyHeader('urgency: fyi\n天气速览')).toEqual({ urgency: 'fyi' });
  });

  it('matches the key and value case-insensitively and tolerates spacing', () => {
    expect(parseUrgencyHeader('URGENCY: MUST_TODAY')).toEqual({ urgency: 'must_today' });
    expect(parseUrgencyHeader('  Urgency :  Can_Wait  ')).toEqual({ urgency: 'can_wait' });
  });

  it('strips leading blank lines before the 3-line window', () => {
    expect(parseUrgencyHeader('\n\n\nurgency: must_today\n正文')).toEqual({ urgency: 'must_today' });
  });

  it('ignores a header beyond the first 3 lines', () => {
    expect(parseUrgencyHeader('第一行\n第二行\n第三行\nurgency: must_today')).toEqual({ urgency: 'fyi' });
    expect(parseUrgencyHeader('\n\n第一行\n第二行\n第三行\nurgency: can_wait')).toEqual({ urgency: 'fyi' });
  });

  it('falls back to fyi with the raw line kept for a garbled value', () => {
    expect(parseUrgencyHeader('urgency: maybe\n正文')).toEqual({ urgency: 'fyi', raw: 'urgency: maybe' });
    expect(parseUrgencyHeader('URGENCY:  今日 ')).toEqual({ urgency: 'fyi', raw: 'URGENCY:  今日' });
  });

  it('falls back to fyi without raw when no header matches', () => {
    expect(parseUrgencyHeader('普通结果正文，没有头部行')).toEqual({ urgency: 'fyi' });
    expect(parseUrgencyHeader('')).toEqual({ urgency: 'fyi' });
    // 空值/多余内容不构成匹配行：不算乱值，不保留 raw
    expect(parseUrgencyHeader('urgency:')).toEqual({ urgency: 'fyi' });
    expect(parseUrgencyHeader('urgency: must_today extra')).toEqual({ urgency: 'fyi' });
  });

  it('never throws on non-string input and treats it as fyi', () => {
    expect(parseUrgencyHeader(undefined)).toEqual({ urgency: 'fyi' });
    expect(parseUrgencyHeader(null as unknown as string)).toEqual({ urgency: 'fyi' });
    expect(parseUrgencyHeader(123 as unknown as string)).toEqual({ urgency: 'fyi' });
  });
});

describe('isCronUrgency', () => {
  it('accepts only the three tier literals', () => {
    expect(isCronUrgency('must_today')).toBe(true);
    expect(isCronUrgency('can_wait')).toBe(true);
    expect(isCronUrgency('fyi')).toBe(true);
    expect(isCronUrgency('MUST_TODAY')).toBe(false);
    expect(isCronUrgency('maybe')).toBe(false);
    expect(isCronUrgency(undefined)).toBe(false);
    expect(isCronUrgency({ urgency: 'fyi' })).toBe(false);
  });
});

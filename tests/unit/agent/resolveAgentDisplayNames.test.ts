import { describe, expect, it } from 'vitest';
import { resolveAgentDisplayNames } from '../../../src/host/agent/resolveAgentDisplayNames';

describe('resolveAgentDisplayNames (A4)', () => {
  it('uses model-provided name when present', () => {
    expect(
      resolveAgentDisplayNames([
        { role: '溯真', name: '溯真-权威资料' },
        { role: '溯真', name: '溯真-行业研究' },
      ]),
    ).toEqual(['溯真-权威资料', '溯真-行业研究']);
  });

  it('suffixes duplicate roles when name is omitted', () => {
    expect(
      resolveAgentDisplayNames([
        { role: '溯真' },
        { role: '溯真' },
      ]),
    ).toEqual(['溯真-1', '溯真-2']);
  });

  it('keeps bare role when name is omitted and role is unique', () => {
    expect(
      resolveAgentDisplayNames([
        { role: '溯真' },
        { role: '青禾' },
      ]),
    ).toEqual(['溯真', '青禾']);
  });

  it('trims provided names and still auto-suffixes others without names', () => {
    expect(
      resolveAgentDisplayNames([
        { role: '溯真', name: '  权威侧  ' },
        { role: '溯真' },
        { role: '溯真' },
      ]),
    ).toEqual(['权威侧', '溯真-1', '溯真-2']);
  });
});

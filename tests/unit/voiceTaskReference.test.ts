import { describe, expect, it } from 'vitest';
import type { VoiceWorkItem } from '../../src/shared/contract/voice';
import { resolveVoiceTaskReference } from '../../src/host/services/voice/voiceTaskReference';

function item(id: string, shortName: string, title = shortName): VoiceWorkItem {
  return { id, shortName, title, status: 'running' };
}

describe('resolveVoiceTaskReference', () => {
  const items = [item('a', '周报', '整理周报'), item('b', '机票', '预订机票')];

  it('routes exact short name and stable ordinal', () => {
    expect(resolveVoiceTaskReference(items, '机票')).toMatchObject({ outcome: 'resolved', item: { id: 'b' } });
    expect(resolveVoiceTaskReference(items, '2号')).toMatchObject({ outcome: 'resolved', item: { id: 'b' } });
  });

  it('does not guess when no target is provided for multiple live tasks', () => {
    expect(resolveVoiceTaskReference(items)).toMatchObject({ outcome: 'ambiguous', candidates: items });
  });

  it('does not route an ambiguous compound reference', () => {
    expect(resolveVoiceTaskReference(items, '1 或 2')).toEqual({ outcome: 'missing' });
  });

  it('ignores terminal tasks', () => {
    expect(resolveVoiceTaskReference([{ ...items[0], status: 'cancelled' }], '周报'))
      .toEqual({ outcome: 'missing' });
  });
});

import { describe, expect, it } from 'vitest';
import { createHandoffTailStreamFilter } from '../../../src/host/handoff/handoffStream';

describe('handoff stream filter', () => {
  it('suppresses streamed handoff proposal tails split across chunks', () => {
    const emitted: string[] = [];
    const filter = createHandoffTailStreamFilter((text) => emitted.push(text));

    filter.push('Done.\n<hand');
    filter.push('off-proposal>{"worthHandoff":true}</handoff-proposal>');
    filter.flush();

    expect(emitted.join('')).toBe('Done.\n');
  });

  it('flushes ordinary content when no handoff tail begins', () => {
    const emitted: string[] = [];
    const filter = createHandoffTailStreamFilter((text) => emitted.push(text));

    filter.push('regular content');
    filter.flush();

    expect(emitted.join('')).toBe('regular content');
  });
});

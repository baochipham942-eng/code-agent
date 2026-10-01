import { describe, expect, it } from 'vitest';
import { resolveEventSinks } from '../../../../src/host/services/eventing/eventSinks';
import type { EventDomain } from '../../../../src/host/protocol/events/busTypes';

const persistentDomains: EventDomain[] = ['tool', 'agent', 'session'];
type SinkTable = NonNullable<Parameters<typeof resolveEventSinks>[3]>;

describe('resolveEventSinks', () => {
  it('keeps the empty shipped table equivalent to the pre-change defaults', () => {
    const cases: Array<{ domain: EventDomain; type: string; callSiteBridge?: boolean }> = [
      { domain: 'agent', type: 'start' },
      { domain: 'session', type: 'open', callSiteBridge: false },
      { domain: 'tool', type: 'result', callSiteBridge: true },
      { domain: 'planning', type: 'step' },
      { domain: 'memory', type: 'load', callSiteBridge: false },
      { domain: 'lsp', type: 'diagnostic', callSiteBridge: true },
      { domain: 'system', type: 'health' },
      { domain: 'ui', type: 'notice', callSiteBridge: false },
      { domain: 'swarm', type: 'message', callSiteBridge: true },
      { domain: 'workflow', type: 'complete', callSiteBridge: false },
      { domain: 'tool', type: 'warning' },
      { domain: 'system', type: 'shutdown', callSiteBridge: true },
    ];

    for (const { domain, type, callSiteBridge } of cases) {
      expect(resolveEventSinks(domain, type, callSiteBridge)).toEqual({
        persist: persistentDomains.includes(domain),
        external: callSiteBridge ?? true,
      });
    }
  });

  it.each([
    { sink: 'persist', flag: true, expected: { persist: true, external: false } },
    { sink: 'external', flag: false, expected: { persist: false, external: true } },
    { sink: 'both', flag: false, expected: { persist: true, external: true } },
    { sink: 'none', flag: true, expected: { persist: false, external: false } },
  ] as const)('resolves a $sink row over a conflicting call-site flag', ({ sink, flag, expected }) => {
    const table: SinkTable = { 'planning:declared': sink };
    expect(resolveEventSinks('planning', 'declared', flag, table)).toEqual(expected);
  });

  it('lets a matching row override the call-site flag without affecting siblings', () => {
    const table: SinkTable = { 'tool:override': 'external' };

    expect(resolveEventSinks('tool', 'override', false, table)).toEqual({ persist: false, external: true });
    expect(resolveEventSinks('tool', 'sibling', false, table)).toEqual({ persist: true, external: false });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordSessionCacheHit = vi.hoisted(() => vi.fn(() => ({
  kind: 'effective',
  effective: 1,
  idle: 0,
})));
const findActiveSpanByAttribute = vi.hoisted(() => vi.fn());
const updateSpan = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/model/cacheHitObservation', () => ({
  recordSessionCacheHit,
}));
vi.mock('../../../src/host/telemetry/telemetryService', () => ({
  getTelemetryService: () => ({ findActiveSpanByAttribute, updateSpan }),
}));

import { markToolCacheHit } from '../../../src/host/tools/toolExecutionTelemetry';

describe('tool cache telemetry isolation', () => {
  beforeEach(() => {
    recordSessionCacheHit.mockClear();
    findActiveSpanByAttribute.mockClear();
    updateSpan.mockClear();
  });

  it('skips an undefined session instead of using a shared bucket', () => {
    markToolCacheHit('call-1', { fingerprint: 'fp' });

    expect(recordSessionCacheHit).not.toHaveBeenCalled();
  });

  it('swallows cache observation failures', () => {
    recordSessionCacheHit.mockImplementationOnce(() => { throw new Error('telemetry down'); });

    expect(() => markToolCacheHit('call-1', { sessionId: 'session-1', fingerprint: 'fp' })).not.toThrow();
  });
});

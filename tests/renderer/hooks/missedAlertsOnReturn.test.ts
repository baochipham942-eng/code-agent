import { describe, expect, it } from 'vitest';
import { createMissedAlertQueue } from '../../../src/renderer/hooks/missedAlertsOnReturn';

const ev = (id: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: 't', body: 'b', sessionId, urgent: true, ...extra }) as never;

describe('missedAlertsOnReturn queue', () => {
  it('records unattended urgent and flushes once', () => {
    const q = createMissedAlertQueue();
    q.record(ev('1', 's1', { failure: true }), false);
    expect(q.flush('other')).toMatchObject({ type: 'error', count: 1 });
    expect(q.flush('other')).toBeNull();
  });
  it('ignores attended, non-urgent', () => {
    const q = createMissedAlertQueue();
    q.record(ev('1', 's1'), true);
    q.record({ id: '2', title: 't', body: 'b', sessionId: 's' }, false);
    expect(q.flush(null)).toBeNull();
  });
  it('dedupes by id', () => {
    const q = createMissedAlertQueue();
    q.record(ev('1', 's1'), false);
    q.record(ev('1', 's1'), false);
    expect(q.flush(null)?.count).toBe(1);
  });
  it('drops current-session events', () => {
    const q = createMissedAlertQueue();
    q.record(ev('1', 'cur', { failure: true }), false);
    expect(q.flush('cur')).toBeNull();
  });
  it('merges several: latest wins, needs-input only => warning', () => {
    const q = createMissedAlertQueue();
    q.record(ev('1', 'a'), false);
    q.record(ev('2', 'b'), false);
    const spec = q.flush(null)!;
    expect(spec).toMatchObject({ type: 'warning', count: 2 });
    expect(spec.latest.sessionId).toBe('b');
  });
});

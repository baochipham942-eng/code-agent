import { describe, expect, it } from 'vitest';
import { StallObserver } from '../../../src/host/agent/stallObserver';

describe('StallObserver', () => {
  it('hints at 90s and escalates at 5min while a tool is quiet', () => {
    const observer = new StallObserver(0);
    expect(observer.tick(89_000, 'tool', 'Read')).toBeNull();
    expect(observer.tick(90_000, 'tool', 'Read')).toEqual({
      level: 'hint', phase: 'tool', detail: 'Read',
    });
    expect(observer.tick(120_000, 'tool', 'Read')).toBeNull();
    expect(observer.tick(300_000, 'tool', 'Read')).toEqual({
      level: 'escalated', phase: 'tool', detail: 'Read',
    });
  });

  it('resets the clock when something visible happens', () => {
    const observer = new StallObserver(0);
    observer.noteProgress('tool:1', 80_000);
    expect(observer.tick(160_000, 'model', '等模型回响')).toBeNull();
    expect(observer.tick(170_000, 'model', '等模型回响')).toEqual({
      level: 'hint', phase: 'model', detail: '等模型回响',
    });
  });
});

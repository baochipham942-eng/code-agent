import { describe, expect, it } from 'vitest';
import { ControlState } from '../../../src/host/agent/runtime/controlState';

describe('ControlState cancel reason', () => {
  it('records the reason passed to markCancelled', () => {
    const control = new ControlState();
    expect(control.cancelReason).toBeUndefined();
    control.markCancelled('idle-reaped');
    expect(control.isCancelled).toBe(true);
    expect(control.cancelReason).toBe('idle-reaped');
  });

  it('leaves the reason absent for a plain user cancel', () => {
    const control = new ControlState();
    control.markCancelled();
    expect(control.isCancelled).toBe(true);
    expect(control.cancelReason).toBeUndefined();
  });
});

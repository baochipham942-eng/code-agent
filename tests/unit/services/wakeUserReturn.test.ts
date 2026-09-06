import { beforeEach, describe, expect, it, vi } from 'vitest';
const cancelForSession = vi.hoisted(() => vi.fn());
const addMessageToSession = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/wake/wakeService', () => ({ getWakeService: () => ({ cancelForSession }) }));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({ getSessionManager: () => ({ addMessageToSession }) }));
import { cancelTimeWakesOnUserReturn } from '../../../src/host/services/wake/userReturn';
beforeEach(() => { vi.clearAllMocks(); cancelForSession.mockReturnValue(1); });
describe('user return wiring', () => {
  it('cancels time wakes and persists a session receipt', async () => {
    await cancelTimeWakesOnUserReturn('user-session');
    expect(cancelForSession).toHaveBeenCalledWith('user-session', 'time');
    expect(addMessageToSession).toHaveBeenCalledWith('user-session', expect.objectContaining({
      role: 'system', content: expect.stringContaining('已取消 1 个定时唤醒'),
    }));
  });
  it.each([{ inputSource: 'automation' as const }, { historyVisibility: 'meta' as const },
    { inputHistoryVisibility: 'meta' as const }])('preserves wakes for automated input: %j', async (options) => {
    await cancelTimeWakesOnUserReturn('s', options);
    expect(cancelForSession).not.toHaveBeenCalled();
    expect(addMessageToSession).not.toHaveBeenCalled();
  });
  it('does not create a receipt without a cancelled wake', async () => {
    cancelForSession.mockReturnValue(0);
    await cancelTimeWakesOnUserReturn('s');
    expect(addMessageToSession).not.toHaveBeenCalled();
  });
});

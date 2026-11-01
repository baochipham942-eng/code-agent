// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const handlers = vi.hoisted(() => ({ show: null as null | ((e: unknown) => void) }));
const postOsNotification = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (channel: string, cb: (e: unknown) => void) => {
      if (channel === 'notification:show' || channel === IPC_CHANNELS.NOTIFICATION_SHOW) handlers.show = cb;
      return () => {};
    },
  },
}));
vi.mock('../../../src/renderer/utils/osNotification', () => ({
  postOsNotification,
  registerNotificationClick: vi.fn(async () => undefined),
}));

import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';

afterEach(() => {
  cleanup();
  postOsNotification.mockClear();
});

describe('useCronOsNotification urgent 转发', () => {
  it('把事件的 urgent 传给 postOsNotification，缺省为 false', () => {
    renderHook(() => useCronOsNotification({} as never, () => {}));
    expect(handlers.show).toBeTruthy();
    handlers.show!({ id: '1', title: '任务失败 - A', body: 'b', sessionId: 's', urgent: true });
    handlers.show!({ id: '2', title: '任务完成 - A', body: 'b', sessionId: 's' });
    expect(postOsNotification.mock.calls[0][1]).toEqual({ urgent: true });
    expect(postOsNotification.mock.calls[1][1]).toEqual({ urgent: false });
  });
});

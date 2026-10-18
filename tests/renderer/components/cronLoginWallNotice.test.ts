// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { NotificationShowEvent } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  warning: vi.fn(),
  invokeDomain: vi.fn().mockResolvedValue(undefined),
  domainInvoke: vi.fn().mockResolvedValue({ success: true, data: null }),
  notificationHandler: null as ((event: NotificationShowEvent) => void) | null,
  notificationUnsubscribe: vi.fn(),
  clickHandler: null as (() => void) | null,
  notificationUnregister: vi.fn(),
  postOsNotification: vi.fn(),
  registerNotificationClick: vi.fn(),
  language: 'zh' as const,
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { warning: mocks.warning },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: mocks.invokeDomain,
    on: vi.fn((_channel: string, handler: (event: NotificationShowEvent) => void) => {
      mocks.notificationHandler = handler;
      return mocks.notificationUnsubscribe;
    }),
  },
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: { getState: () => ({ language: mocks.language }) },
}));
vi.mock('../../../src/renderer/components/features/cron/cronFailureNotice', () => ({
  translateCronOsNotification: vi.fn(() => ({ title: 'title', body: 'body' })),
}));
vi.mock('../../../src/renderer/utils/osNotification', () => ({
  postOsNotification: mocks.postOsNotification,
  registerNotificationClick: mocks.registerNotificationClick,
}));

Object.defineProperty(window, 'domainAPI', {
  configurable: true,
  value: { invoke: mocks.domainInvoke },
});

import {
  cronLoginWallCopy,
  cronLoginWallSiteOriginFromNotification,
  openCronLoginWallSite,
  showCronLoginWallWarning,
} from '../../../src/renderer/components/features/cron/cronLoginWallNotice';
import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';

const notificationCopy = {} as Parameters<typeof useCronOsNotification>[0];

describe('cron login-wall renderer surface', () => {
  beforeEach(() => {
    mocks.warning.mockClear();
    mocks.invokeDomain.mockClear();
    mocks.domainInvoke.mockClear();
    mocks.notificationHandler = null;
    mocks.clickHandler = null;
    mocks.notificationUnsubscribe.mockClear();
    mocks.notificationUnregister.mockClear();
    mocks.postOsNotification.mockClear();
    mocks.registerNotificationClick.mockImplementation(async (handler: () => void) => {
      mocks.clickHandler = handler;
      return async () => {
        mocks.notificationUnregister();
      };
    });
  });

  afterEach(cleanup);

  it('formats the localized login-again message with the site origin', () => {
    expect(cronLoginWallCopy(
      'CRON_LOGIN_WALL_STOP|https://example.test',
      { error: 'You need to log in to {site} again' },
    )).toEqual({
      siteOrigin: 'https://example.test',
      message: 'You need to log in to https://example.test again',
    });
  });

  it('warns on create/edit and wires the open-site action', () => {
    showCronLoginWallWarning(
      { metadata: { loginGatedSiteOrigin: 'https://example.test' } } as never,
      { warning: 'Log in to {site} once first', openSite: 'Open site' },
    );

    expect(mocks.warning).toHaveBeenCalledWith(
      'Log in to https://example.test once first',
      expect.objectContaining({ label: 'Open site' }),
    );
    const action = mocks.warning.mock.calls[0][1] as { onClick: () => void };
    action.onClick();
    expect(mocks.invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.DESKTOP,
      'openManagedBrowserUrl',
      { url: 'https://example.test', mode: 'visible', profileMode: 'persistent' },
    );
    openCronLoginWallSite('https://example.test');
    expect(mocks.invokeDomain).toHaveBeenCalledTimes(2);
  });

  it('recognizes login-wall notification actions', () => {
    expect(cronLoginWallSiteOriginFromNotification({
      code: 'CRON_LOGIN_WALL_STOP',
      siteOrigin: 'https://example.test',
    })).toBe('https://example.test');
    expect(cronLoginWallSiteOriginFromNotification({
      code: 'CRON_FAILURE',
      siteOrigin: 'https://example.test',
    })).toBeUndefined();
  });

  it('persists the explicit pass-through consent with the job and origin', async () => {
    openCronLoginWallSite('https://example.test/path', 'job-1');
    await Promise.resolve();
    expect(mocks.domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.CRON,
      'updateJob',
      { jobId: 'job-1', updates: { metadata: { loginPassThroughOrigin: 'https://example.test/path' } } },
    );
  });

  it('registers one native click listener across rerenders and uses the latest callback', async () => {
    const firstCallback = vi.fn();
    const latestCallback = vi.fn();
    const view = renderHook(
      ({ onOpenSession }) => useCronOsNotification(notificationCopy, onOpenSession),
      { initialProps: { onOpenSession: firstCallback } },
    );
    view.rerender({ onOpenSession: latestCallback });

    await waitFor(() => expect(mocks.registerNotificationClick).toHaveBeenCalledTimes(1));
    act(() => {
      mocks.notificationHandler?.({ id: 'notice-1', title: 'title', body: 'body', sessionId: 'session-1' });
      mocks.clickHandler?.();
    });

    expect(latestCallback).toHaveBeenCalledTimes(1);
    expect(latestCallback).toHaveBeenCalledWith('session-1');
    expect(firstCallback).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(mocks.notificationUnregister).toHaveBeenCalledTimes(1));
  });
});

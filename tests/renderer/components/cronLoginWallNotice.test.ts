// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  warning: vi.fn(),
  invokeDomain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { warning: mocks.warning },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: mocks.invokeDomain,
  },
}));

import {
  cronLoginWallCopy,
  cronLoginWallSiteOriginFromNotification,
  openCronLoginWallSite,
  showCronLoginWallWarning,
} from '../../../src/renderer/components/features/cron/cronLoginWallNotice';

describe('cron login-wall renderer surface', () => {
  beforeEach(() => {
    mocks.warning.mockClear();
    mocks.invokeDomain.mockClear();
  });

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
});

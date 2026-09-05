// @vitest-environment jsdom
// N-EVAL-POSTLAUNCH-K2 验收⑧：上线后评分开关放在「权限与数据边界」页，与诊断包同族。
// 三态（跟随默认 / 开 / 关），文案必须写明花的是用户自己的额度和每天上限。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { POST_LAUNCH_DEFAULTS } from '../../../src/shared/contract/postLaunchScore';
import { zh } from '../../../src/renderer/i18n/zh';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } }) => unknown) => selector({ user: { isAdmin: true } }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: vi.fn() },
}));

import PrivacySettings from '../../../src/renderer/components/features/settings/tabs/PrivacySettings';

afterEach(() => cleanup());

function mockIpc(settings: Record<string, unknown>): void {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  invokeDomain.mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve(settings);
    if (domain === IPC_DOMAINS.SETTINGS && action === 'set') return Promise.resolve(undefined);
    if (domain === IPC_DOMAINS.PII && action === 'setup:status') {
      return Promise.resolve({ state: 'idle', startedAt: null, error: null, logTail: [] });
    }
    if (domain === IPC_DOMAINS.PII && action === 'setup:isReady') {
      return Promise.resolve({ ready: false, envFile: { exists: false, hasPiiKeys: false }, pythonPath: null, modelOnnx: null });
    }
    throw new Error(`Unexpected call ${domain}:${action}`);
  });
}

describe('PrivacySettings 上线后质量评分开关', () => {
  it('没设置过时停在「跟随默认」，选「关」会显式落盘', async () => {
    mockIpc({});
    render(<PrivacySettings />);

    const select = await screen.findByTestId('postlaunch-scoring-switch');
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('auto'));

    fireEvent.change(select, { target: { value: 'off' } });
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'set',
        { privacy: { postLaunchScoring: 'off' } },
      );
    });
  });

  it('已显式打开时回显「开」，且文案写明花谁的额度、每天上限多少', async () => {
    mockIpc({ privacy: { postLaunchScoring: 'on' } });
    render(<PrivacySettings />);

    const select = await screen.findByTestId('postlaunch-scoring-switch');
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('on'));

    const body = zh.settings.privacy.telemetry.postLaunchScoring.body
      .replace('{limit}', POST_LAUNCH_DEFAULTS.dailyBudgetUsd.toFixed(2));
    expect(body).toContain('用你自己的模型额度');
    expect(body).toContain('$0.50');
    expect(screen.getByText(body)).toBeTruthy();
  });
});

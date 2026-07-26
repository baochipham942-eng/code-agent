// @vitest-environment jsdom
//
// B5 设置 → 语音「实时通话」组：总开关/Provider 状态/音色白名单/打断三态持久化，
// 且 turnDetection 与 UI 三态同写不分叉（运行时真源只有 turnDetection）。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AppSettings } from '../../../src/shared/contract';

const invokeDomainMock = vi.hoisted(() => vi.fn());
const availability = vi.hoisted(() => ({ enabled: true, configured: true }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomainMock(...args) },
}));
vi.mock('../../../src/renderer/components/features/voice/useVoiceLiveAvailability', () => ({
  useVoiceLiveAvailability: () => availability,
}));

import { VoiceLiveSettingsSection } from '../../../src/renderer/components/features/settings/tabs/VoiceLiveSettingsSection';

function settingsGet(voice?: AppSettings['voice']) {
  invokeDomainMock.mockImplementation((_domain: string, action: string) => {
    if (action === 'get') return Promise.resolve({ voice } as AppSettings);
    return Promise.resolve(undefined);
  });
}

describe('VoiceLiveSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availability.configured = true;
  });
  afterEach(() => cleanup());

  it('Provider 已配置显示「已配置」，未配置显示引导文案（§9.3）', async () => {
    settingsGet(undefined);
    const { unmount } = render(<VoiceLiveSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('voice-provider-status').textContent).toBe(zh.voice.settings.providerConfigured));
    unmount();

    availability.configured = false;
    render(<VoiceLiveSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('voice-provider-status').textContent).toBe(zh.voice.settings.providerMissing));
    expect(screen.getByText(zh.voice.settings.providerMissingHint)).toBeTruthy();
  });

  it('音色选择器只出实测白名单三项', async () => {
    settingsGet(undefined);
    render(<VoiceLiveSettingsSection />);
    await waitFor(() => expect(invokeDomainMock).toHaveBeenCalled());
    const select = screen.getByText(zh.voice.settings.voiceLabel).parentElement!.querySelector('select')!;
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['Tina', 'Ethan', 'Serena']);
  });

  it('总开关持久化 live.enabled，并同写 turnDetection（默认 server_vad medium）', async () => {
    settingsGet(undefined);
    render(<VoiceLiveSettingsSection />);
    await waitFor(() => expect(invokeDomainMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('switch', { name: zh.voice.settings.enableTitle }));
    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'set');
      expect(setCall).toBeTruthy();
      const payload = setCall![2] as { voice: { enabled?: boolean; turnDetection: unknown; live: { enabled?: boolean } } };
      expect(payload.voice.live.enabled).toBe(true);
      expect(payload.voice.turnDetection).toMatchObject({ type: 'server_vad', threshold: 0.5 });
    });
  });

  it('选 PTT 后 turnDetection 写 null（B6 手动 commit 前提），灵敏度选择隐藏', async () => {
    settingsGet({ live: { enabled: true }, turnDetection: { type: 'server_vad' } });
    render(<VoiceLiveSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('voice-vad-sensitivity')).toBeTruthy());

    fireEvent.click(screen.getByTestId('voice-interrupt-push_to_talk'));
    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'set');
      expect(setCall).toBeTruthy();
      const payload = setCall![2] as { voice: { turnDetection: unknown; live: { interrupt?: string } } };
      expect(payload.voice.live.interrupt).toBe('push_to_talk');
      expect(payload.voice.turnDetection).toBeNull();
    });
    expect(screen.queryByTestId('voice-vad-sensitivity')).toBeNull();
  });

  it('灵敏度档位映射 threshold（low → 0.7）', async () => {
    settingsGet({ live: { enabled: true }, turnDetection: { type: 'server_vad' } });
    render(<VoiceLiveSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('voice-vad-sensitivity')).toBeTruthy());

    fireEvent.change(screen.getByTestId('voice-vad-sensitivity'), { target: { value: 'low' } });
    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'set');
      const payload = setCall![2] as { voice: { turnDetection: { threshold?: number } } };
      expect(payload.voice.turnDetection.threshold).toBe(0.7);
    });
  });
});

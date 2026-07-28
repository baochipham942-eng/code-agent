// @vitest-environment jsdom
//
// B5 设置 → 语音「实时通话」组：总开关/打断三态持久化，
// 且 turnDetection 与 UI 三态同写不分叉（运行时真源只有 turnDetection）。
// T1（2026-07-28）：通话模型/Provider 状态/音色白名单搬去「语音模型」tab，
// 相关断言在 voiceModelSettings.test.tsx。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AppSettings } from '../../../src/shared/contract';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeDomainMock = vi.hoisted(() => vi.fn());
// usage 是批 H 新增：设置页「通话用量」读它。mock 少一个字段整个 tab 就白屏，
// 所以这里跟着真 hook 的返回形状走，不是可选补丁。
const availability = vi.hoisted(() => ({
  enabled: true,
  configured: true,
  usage: { monthSeconds: 0, monthCalls: 0 },
}));

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

  it('选点按说话后 turnDetection 写 null（手动 commit 前提），灵敏度选择隐藏', async () => {
    settingsGet({ live: { enabled: true }, turnDetection: { type: 'server_vad' } });
    render(<VoiceLiveSettingsSection />);
    await waitFor(() => expect(screen.getByTestId('voice-vad-sensitivity')).toBeTruthy());

    fireEvent.click(screen.getByTestId('voice-interrupt-manual'));
    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'set');
      expect(setCall).toBeTruthy();
      const payload = setCall![2] as { voice: { turnDetection: unknown; live: { interrupt?: string } } };
      expect(payload.voice.live.interrupt).toBe('manual');
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

  // 批 H：执行引擎与通话模型分离（§6.1）。判据是「选了真存进 live.executionModel」，
  // 不是「下拉框渲染出来了」——存不进去就是个装饰品。
  it('选执行引擎写 live.executionModel，选回「跟随会话默认」把它去掉', async () => {
    settingsGet(undefined);
    render(<VoiceLiveSettingsSection />);
    const providerSelect = await screen.findByTestId('voice-execution-provider');

    fireEvent.change(providerSelect, { target: { value: 'deepseek' } });
    await waitFor(() => expect(invokeDomainMock).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', expect.anything()));
    const saved = invokeDomainMock.mock.calls.filter((c) => c[1] === 'set').at(-1)?.[2] as Partial<AppSettings>;
    expect(saved.voice?.live?.executionModel?.provider).toBe('deepseek');
    expect(saved.voice?.live?.executionModel?.model).toBeTruthy();

    invokeDomainMock.mockClear();
    fireEvent.change(screen.getByTestId('voice-execution-provider'), { target: { value: '' } });
    await waitFor(() => expect(invokeDomainMock).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', expect.anything()));
    const cleared = invokeDomainMock.mock.calls.filter((c) => c[1] === 'set').at(-1)?.[2] as Partial<AppSettings>;
    expect(cleared.voice?.live?.executionModel).toBeUndefined();
  });

  it('本月通话用量按分钟显示（只记账不设限）', async () => {
    availability.usage = { monthSeconds: 754, monthCalls: 11 };
    settingsGet(undefined);
    render(<VoiceLiveSettingsSection />);

    const summary = await screen.findByTestId('voice-usage-summary');
    expect(summary.textContent).toContain('13');  // 754s ≈ 13 分钟
    expect(summary.textContent).toContain('11');
    availability.usage = { monthSeconds: 0, monthCalls: 0 };
  });

  it('回声消除默认自动，可持久化为强制关', async () => {
    settingsGet({ live: { enabled: true }, turnDetection: { type: 'server_vad' } });
    render(<VoiceLiveSettingsSection />);
    const select = await screen.findByTestId('voice-echo-cancellation') as HTMLSelectElement;
    expect(select.value).toBe('auto');

    fireEvent.change(select, { target: { value: 'off' } });
    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'set');
      const payload = setCall![2] as {
        voice: { live: { echoCancellation?: string } };
      };
      expect(payload.voice.live.echoCancellation).toBe('off');
    });
    expect(screen.getByText(zh.voice.settings.echoCancellationOffDesc)).toBeTruthy();
  });
});

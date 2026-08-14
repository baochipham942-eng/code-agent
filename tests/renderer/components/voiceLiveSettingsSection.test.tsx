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
import { en } from '../../../src/renderer/i18n/en';
import type { AppSettings } from '../../../src/shared/contract';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeDomainMock = vi.hoisted(() => vi.fn());
// usage 是批 H 新增：设置页「通话用量」读它。mock 少一个字段整个 tab 就白屏，
// 所以这里跟着真 hook 的返回形状走，不是可选补丁。
const availability = vi.hoisted(() => ({
  enabled: true,
  configured: true,
  usage: { monthSeconds: 0, monthCalls: 0, monthFailedAttempts: 0 } as import('../../../src/shared/contract/voice').VoiceStatusResponse['usage'],
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
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { VoiceLiveSettingsSection } from '../../../src/renderer/components/features/settings/tabs/VoiceLiveSettingsSection';

function settingsGet(voice?: AppSettings['voice']) {
  invokeDomainMock.mockImplementation((_domain: string, action: string) => {
    if (action === 'get') return Promise.resolve({ voice } as AppSettings);
    return Promise.resolve(undefined);
  });
}

function audioInput(deviceId: string, label: string): MediaDeviceInfo {
  return { deviceId, kind: 'audioinput', label, groupId: '' } as unknown as MediaDeviceInfo;
}

function createMediaDevicesStub(initialDevices: MediaDeviceInfo[] = []) {
  let devices = initialDevices;
  let handler: (() => void) | null = null;
  const stub = {
    enumerateDevices: vi.fn(() => Promise.resolve(devices)),
    addEventListener: vi.fn((_type: string, h: () => void) => { handler = h; }),
    removeEventListener: vi.fn(() => { handler = null; }),
    setDevices(next: MediaDeviceInfo[]) { devices = next; },
    get handler() { return handler; },
  };
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = stub;
  return stub;
}

describe('VoiceLiveSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availability.configured = true;
  });
  afterEach(() => cleanup());

  it('总开关持久化 live.enabled，并同写 turnDetection（默认 server_vad medium）', async () => {
    settingsGet({ live: { enabled: false } });
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

  it('存量设置未写 enabled 时，总开关按默认开启展示', async () => {
    settingsGet({ live: {} });
    render(<VoiceLiveSettingsSection />);

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: zh.voice.settings.enableTitle }).getAttribute('aria-checked'))
        .toBe('true');
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

  it('本月通话用量同时显示时长、通数与 token 估算', async () => {
    availability.usage = {
      monthSeconds: 754,
      monthCalls: 11,
      monthFailedAttempts: 0,
      monthTokens: {
        totalTokens: 377,
        inputTokens: 336,
        outputTokens: 41,
        inputAudioTokens: 108,
        inputTextTokens: 228,
        outputAudioTokens: 32,
        outputTextTokens: 9,
      },
    };
    settingsGet(undefined);
    render(<VoiceLiveSettingsSection />);

    const summary = await screen.findByTestId('voice-usage-summary');
    expect(summary.textContent).toContain('13');  // 754s ≈ 13 分钟
    expect(summary.textContent).toContain('11');
    expect(summary.textContent).toContain('377');
    expect(summary.textContent).toContain('估算');
    expect(summary.textContent).toContain('不代表账单');
    availability.usage = { monthSeconds: 0, monthCalls: 0, monthFailedAttempts: 0 };
  });

  it('保存单通成本上限和默认提醒动作', async () => {
    settingsGet({ live: { callCostLimitAction: 'warn' } });
    render(<VoiceLiveSettingsSection />);
    const input = await screen.findByTestId('voice-cost-limit');

    fireEvent.change(input, { target: { value: '0.25' } });
    fireEvent.blur(input);
    await waitFor(() => {
      const saved = invokeDomainMock.mock.calls.filter((call) => call[1] === 'set').at(-1)?.[2] as Partial<AppSettings>;
      expect(saved.voice?.live?.callCostLimit).toBe(0.25);
      expect(saved.voice?.live?.callCostLimitAction).toBe('warn');
    });
  });

  it('清空单通成本上限时显式保存 0，避免深合并保留旧值', async () => {
    settingsGet({ live: { callCostLimit: 0.25, callCostLimitAction: 'warn' } });
    render(<VoiceLiveSettingsSection />);
    const input = await screen.findByTestId('voice-cost-limit');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => {
      const saved = invokeDomainMock.mock.calls.filter((call) => call[1] === 'set').at(-1)?.[2] as Partial<AppSettings>;
      expect(saved.voice?.live?.callCostLimit).toBe(0);
    });
  });

  it('随时开口引导绑定无冲突全局键，并在冲突时拒绝覆盖', async () => {
    settingsGet(undefined);
    render(<VoiceLiveSettingsSection />);
    const bind = await screen.findByTestId('voice-hotkey-bind');

    fireEvent.click(bind);
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true, shiftKey: true });
    expect(await screen.findByText(/冲突/)).toBeTruthy();
    expect(invokeDomainMock.mock.calls.some((call) => call[1] === 'set')).toBe(false);

    fireEvent.click(bind);
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      const saved = invokeDomainMock.mock.calls.filter((call) => call[1] === 'set').at(-1)?.[2] as Partial<AppSettings>;
      expect(saved.keybindings?.bindings['voice.callToggle']).toEqual({
        enabled: true,
        accelerator: 'Ctrl+Shift+V',
      });
    });
  });

  it('没有 token 数据时整段 token 估算不出现，中英文模板保持同一语义', async () => {
    availability.usage = { monthSeconds: 300, monthCalls: 1, monthFailedAttempts: 0 };
    settingsGet(undefined);
    render(<VoiceLiveSettingsSection />);

    const summary = await screen.findByTestId('voice-usage-summary');
    expect(summary.textContent).toBe('本月 5 分钟 · 1 通。用量估算，仅供参考，不代表账单。');
    expect(summary.textContent).not.toContain('tokens');
    expect(summary.textContent).not.toContain('约');
    expect(en.voice.settings.usageThisMonthWithoutTokens).toBe(
      '{minutes} min · {calls} calls this month. Usage estimate only; not a bill.',
    );
  });

  // key 配置三条断言已随组件迁往 voiceApiKeyConfig.test.tsx（批 X3：key 的家在「语音模型」tab 常驻）

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

  it('选择具体麦克风时保存 label + webDeviceId', async () => {
    createMediaDevicesStub([audioInput('mic-2', 'Mic B')]);
    settingsGet(undefined);
    render(<VoiceLiveSettingsSection />);

    const select = await screen.findByTestId('voice-input-device');
    fireEvent.change(select, { target: { value: 'mic-2' } });

    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'set');
      expect(setCall).toBeTruthy();
      const payload = setCall![2] as Partial<AppSettings>;
      expect(payload.voice?.inputDevice).toEqual({ label: 'Mic B', webDeviceId: 'mic-2' });
    });
  });

  it('选择系统默认时保存 voice.inputDevice = null', async () => {
    createMediaDevicesStub([audioInput('mic-1', 'Mic A')]);
    settingsGet({ inputDevice: { label: 'Mic A', webDeviceId: 'mic-1' } });
    render(<VoiceLiveSettingsSection />);

    const select = await screen.findByTestId('voice-input-device') as HTMLSelectElement;
    expect(select.value).toBe('mic-1');

    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'set');
      const payload = setCall![2] as Partial<AppSettings>;
      expect(payload.voice?.inputDevice).toBeNull();
    });
  });

  it('设备断开时显示回退系统默认且保留配置', async () => {
    createMediaDevicesStub([]);
    settingsGet({ inputDevice: { label: 'Mic A', webDeviceId: 'mic-1' } });
    render(<VoiceLiveSettingsSection />);

    const select = await screen.findByTestId('voice-input-device') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(''));

    const status = await screen.findByTestId('voice-input-device-status');
    expect(status.textContent).toContain(zh.voice.settings.inputDeviceUnavailable);
    expect(invokeDomainMock.mock.calls.some(([, action]) => action === 'set')).toBe(false);
  });

  it('设备初始可用时显示普通可用文案，不显示恢复文案', async () => {
    createMediaDevicesStub([audioInput('mic-1', 'Mic A')]);
    settingsGet({ inputDevice: { label: 'Mic A', webDeviceId: 'mic-1' } });
    render(<VoiceLiveSettingsSection />);

    const status = await screen.findByTestId('voice-input-device-status');
    expect(status.textContent).toContain(zh.voice.settings.inputDeviceAvailable);
    expect(status.textContent).not.toContain(zh.voice.settings.inputDeviceRecovered);
  });

  it('devicechange 从断开到恢复时显示恢复文案', async () => {
    const stub = createMediaDevicesStub([]);
    settingsGet({ inputDevice: { label: 'Mic A', webDeviceId: 'mic-1' } });
    render(<VoiceLiveSettingsSection />);

    await screen.findByText(zh.voice.settings.inputDeviceUnavailable);

    stub.setDevices([audioInput('mic-1', 'Mic A')]);
    stub.handler?.();

    const status = await screen.findByTestId('voice-input-device-status');
    await waitFor(() => expect(status.textContent).toContain(zh.voice.settings.inputDeviceRecovered));
    const select = screen.getByTestId('voice-input-device') as HTMLSelectElement;
    expect(select.value).toBe('mic-1');
  });

  it('枚举失败不清配置', async () => {
    const stub = createMediaDevicesStub([]);
    stub.enumerateDevices.mockRejectedValue(new Error('permission denied'));
    settingsGet({ inputDevice: { label: 'Mic A', webDeviceId: 'mic-1' } });
    render(<VoiceLiveSettingsSection />);

    await waitFor(() => expect(stub.enumerateDevices).toHaveBeenCalled());
    expect(invokeDomainMock.mock.calls.some(([, action]) => action === 'set')).toBe(false);
    const status = await screen.findByTestId('voice-input-device-status');
    expect(status.textContent).toContain(zh.voice.settings.inputDeviceEnumFailed);
  });

  // T7：语速三档（方案 §4.1 UI 半）。未配置 = normal（存量用户不该看到"什么都没选"）；
  // 选中档位必须进 live.speechRate patch——T6 的通话中热更新靠 settings IPC 收到这个字段
  // 触发，patch 里没有它 = 通话中改语速不生效。
  it('语速未配置时显示 normal，三档都能选中并写 live.speechRate', async () => {
    settingsGet({ live: { enabled: true } });
    render(<VoiceLiveSettingsSection />);
    const select = await screen.findByTestId('voice-speech-rate') as HTMLSelectElement;
    expect(select.value).toBe('normal');

    for (const rate of ['slow', 'normal', 'fast'] as const) {
      invokeDomainMock.mockClear();
      fireEvent.change(select, { target: { value: rate } });
      await waitFor(() => {
        const setCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'set');
        expect(setCall).toBeTruthy();
        const payload = setCall![2] as { voice: { live: { speechRate?: string } } };
        expect(payload.voice.live.speechRate).toBe(rate);
      });
    }
  });

  it('语速 helper 文案存在（中英各一条），如实提示可能不完全生效', async () => {
    settingsGet({ live: { enabled: true } });
    render(<VoiceLiveSettingsSection />);
    await screen.findByTestId('voice-speech-rate');

    expect(screen.getByText(zh.voice.settings.speechRateHelper)).toBeTruthy();
    expect(en.voice.settings.speechRateHelper).toBeTruthy();
  });

  // ── 声纹身份（N-L7-SPK）──────────────────────────────────────────────
  //
  // 判据 1 的 UI 面：默认态展示「未注册」；判据 5 的入口面：清除走二次确认。
  // 「能力表述与隐私说明同框」是调研结论（孤立的能力宣传会变成呈堂证供），
  // 所以隐私正文与四要点在这里当结构断言钉住，不只是文案存在性。
  function voiceprintOverview(over: {
    registered?: boolean; sampleCount?: number; modelReady?: boolean; runtimeReady?: boolean; callActive?: boolean;
  } = {}) {
    return {
      status: { registered: over.registered ?? false, ...(over.sampleCount ? { sampleCount: over.sampleCount } : {}) },
      runtime: { modelReady: over.modelReady ?? true, runtimeReady: over.runtimeReady ?? true },
      callActive: over.callActive ?? false,
    };
  }

  function settingsGetWithVoiceprint(
    voice: AppSettings['voice'],
    overview: ReturnType<typeof voiceprintOverview>,
    extra?: (action: string) => unknown,
  ) {
    invokeDomainMock.mockImplementation((_domain: string, action: string) => {
      if (action === 'get') return Promise.resolve({ voice } as AppSettings);
      if (action === 'voiceprintOverview') return Promise.resolve(overview);
      const handled = extra?.(action);
      if (handled !== undefined) return Promise.resolve(handled);
      return Promise.resolve(undefined);
    });
  }

  it('默认态：声纹开关开着，状态显示未注册，且隐私说明与能力表述同框（判据1 UI 面）', async () => {
    settingsGetWithVoiceprint({ live: { enabled: true } }, voiceprintOverview());
    render(<VoiceLiveSettingsSection />);

    await screen.findByTestId('voiceprint-manage');
    expect(screen.getByRole('switch', { name: zh.voice.settings.voiceprintToggleLabel }).getAttribute('aria-checked'))
      .toBe('true');
    expect(screen.getByTestId('voiceprint-status').textContent).toBe(zh.voice.settings.voiceprintStatusUnregistered);
    // 四要点：隔离存储 / 准确率如实 / 删除时限具体数字 / 非生物识别替代路径
    const privacy = screen.getByTestId('voiceprint-privacy').textContent ?? '';
    expect(privacy).toContain('隔离存储');
    expect(privacy).toContain('无法完全保证');
    expect(privacy).toMatch(/90\s*天/);
    expect(privacy).toContain('核心功能不受影响');
    expect(en.voice.settings.voiceprintPrivacyBody).toBeTruthy();
  });

  it('关掉声纹开关：持久化 voiceprint=false，且管理区整体消失（不做任何声纹运算）', async () => {
    settingsGetWithVoiceprint({ live: { enabled: true } }, voiceprintOverview());
    render(<VoiceLiveSettingsSection />);
    await screen.findByTestId('voiceprint-manage');

    fireEvent.click(screen.getByRole('switch', { name: zh.voice.settings.voiceprintToggleLabel }));
    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'set');
      expect(setCall).toBeTruthy();
      expect((setCall![2] as { voice: { live: { voiceprint?: boolean } } }).voice.live.voiceprint).toBe(false);
    });
    expect(screen.queryByTestId('voiceprint-manage')).toBeNull();
  });

  it('模型未下载：只出下载入口，不出注册/清除（能力没就绪就别给按钮）', async () => {
    settingsGetWithVoiceprint({ live: { enabled: true } }, voiceprintOverview({ modelReady: false }));
    render(<VoiceLiveSettingsSection />);

    await screen.findByTestId('voiceprint-download');
    expect(screen.queryByTestId('voiceprint-register')).toBeNull();
    expect(screen.queryByTestId('voiceprint-clear')).toBeNull();
  });

  it('无进行中通话时注册按钮禁用（注册必须发生在真通话里）', async () => {
    settingsGetWithVoiceprint({ live: { enabled: true } }, voiceprintOverview({ callActive: false }));
    render(<VoiceLiveSettingsSection />);

    const register = await screen.findByTestId('voiceprint-register') as HTMLButtonElement;
    expect(register.disabled).toBe(true);
    expect(screen.getByText(zh.voice.settings.voiceprintRegisterHint)).toBeTruthy();
  });

  it('清除声纹必须过二次确认；确认后才发 voiceprintClear（判据5 入口面）', async () => {
    let cleared = false;
    settingsGetWithVoiceprint(
      { live: { enabled: true } },
      voiceprintOverview({ registered: true, sampleCount: 2 }),
      (action) => {
        if (action !== 'voiceprintClear') return undefined;
        cleared = true;
        return voiceprintOverview();
      },
    );
    render(<VoiceLiveSettingsSection />);

    fireEvent.click(await screen.findByTestId('voiceprint-clear'));
    // 点了按钮但没确认 → 一个清除请求都不许发出去
    expect(cleared).toBe(false);
    expect(invokeDomainMock.mock.calls.some(([, action]) => action === 'voiceprintClear')).toBe(false);
    // 确认框真的开了：不可逆动作的后果文案必须在场
    expect(screen.getByText(zh.voice.settings.voiceprintClearConfirm)).toBeTruthy();

    // 触发按钮与确认按钮同名，确认按钮是后出现的那个（对话框在 DOM 尾部）
    const clearButtons = screen.getAllByRole('button', { name: zh.voice.settings.voiceprintClear });
    expect(clearButtons.length).toBe(2);
    fireEvent.click(clearButtons[clearButtons.length - 1]);
    await waitFor(() => expect(cleared).toBe(true));
    await waitFor(() => {
      expect(screen.getByTestId('voiceprint-status').textContent).toBe(zh.voice.settings.voiceprintStatusUnregistered);
    });
  });
});

// @vitest-environment jsdom
//
// T1（2026-07-28）：「语音模型」tab 收拢通话模型 / 音色 / 转写模型。
// 本文件钉住三条验收：
//   1. 新 tab 在「模型与能力」组（与通用模型/多模态模型并列）；
//   2. 搬家不是复制——三项在原 voiceLive / voiceInput tab 已不存在；
//   3. voiceLive / voiceInput tab id 保留，深链落点不变（resolveSettingsDeepLink）。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AppSettings } from '../../../src/shared/contract';
import {
  SETTINGS_TAB_IDS,
  resolveSettingsDeepLink,
} from '../../../src/renderer/utils/settingsTabs';

const invokeDomainMock = vi.hoisted(() => vi.fn());
// 形状跟随真 hook：VoiceModelSettings 读 configured，VoiceLiveSettingsSection 读 usage
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
vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: {
    getState: () => ({ status: 'disconnected' }),
  },
}));
vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({
    invokeTool: vi.fn(),
  }),
}));

import { VoiceModelSettings } from '../../../src/renderer/components/features/settings/tabs/VoiceModelSettings';
import { VoiceLiveSettingsSection } from '../../../src/renderer/components/features/settings/tabs/VoiceLiveSettingsSection';
import { VoiceInputSettings } from '../../../src/renderer/components/features/settings/tabs/VoiceInputSettings';
import { buildSettingsTabGroups } from '../../../src/renderer/components/features/settings/SettingsModal';

function settingsGet(voice?: AppSettings['voice'], speech?: AppSettings['speech']) {
  invokeDomainMock.mockImplementation((_domain: string, action: string) => {
    if (action === 'get') return Promise.resolve({ voice, speech } as AppSettings);
    return Promise.resolve(undefined);
  });
}

describe('「语音模型」tab 归属与深链', () => {
  it('出现在「模型与能力」组，紧跟通用模型/多模态模型之后', () => {
    const groups = buildSettingsTabGroups({
      t: zh,
      showScreenMemoryTab: true,
      showUpdateTab: true,
      hasOptionalUpdate: false,
      access: { isAdmin: true },
    });
    const models = groups.find((group) => group.id === 'models');
    expect(models?.tabs.map((tab) => tab.id)).toEqual([
      'model',
      'visualModels',
      'voiceModel',
      'search',
      'soul',
    ]);
    expect(models?.tabs[2].label).toBe('语音模型');
  });

  it('voiceLive / voiceInput tab id 保留，深链仍落设置页原 tab', () => {
    expect(SETTINGS_TAB_IDS).toContain('voiceLive');
    expect(SETTINGS_TAB_IDS).toContain('voiceInput');
    expect(resolveSettingsDeepLink('voiceLive')).toEqual({ kind: 'settings', tab: 'voiceLive' });
    expect(resolveSettingsDeepLink('voiceInput')).toEqual({ kind: 'settings', tab: 'voiceInput' });
  });
});

describe('VoiceModelSettings（新 tab 收拢三项）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availability.configured = true;
  });
  afterEach(() => cleanup());

  it('渲染通话模型 / 音色 / 转写模型三项', async () => {
    settingsGet(undefined);
    render(<VoiceModelSettings />);
    expect(await screen.findByTestId('voice-conversation-model')).toBeTruthy();
    expect(screen.getByTestId('voice-model-voice-id')).toBeTruthy();
    expect(screen.getByTestId('voice-model-transcription-model')).toBeTruthy();
  });

  it('Provider 已配置显示「已配置」，未配置显示引导文案', async () => {
    settingsGet(undefined);
    const { unmount } = render(<VoiceModelSettings />);
    await waitFor(() => expect(screen.getByTestId('voice-provider-status').textContent).toBe(zh.voice.settings.providerConfigured));
    unmount();

    availability.configured = false;
    render(<VoiceModelSettings />);
    await waitFor(() => expect(screen.getByTestId('voice-provider-status').textContent).toBe(zh.voice.settings.providerMissing));
    expect(screen.getByText(zh.voice.settings.providerMissingHint)).toBeTruthy();
  });

  it('音色选择器只出当前模型的实测白名单', async () => {
    settingsGet(undefined);
    render(<VoiceModelSettings />);
    const select = await screen.findByTestId('voice-model-voice-id');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['Tina', 'Ethan', 'Serena']);
  });

  // 工单③原契约随迁：选不支持 tools 的模型必须当场说清代价；音色与模型强绑定，
  // 换模型时 3.5 的音色（Tina）不能留到上一代模型上（第一次合成才 400）。
  it('换到不支持 tools 的模型：警示行出现，音色回退到该模型第一个合法值并一起持久化', async () => {
    settingsGet({ live: { enabled: true, voiceId: 'Tina' } });
    render(<VoiceModelSettings />);
    const modelSelect = await screen.findByTestId('voice-conversation-model') as HTMLSelectElement;
    expect(modelSelect.value).toBe('qwen3.5-omni-flash-realtime');
    expect(screen.queryByTestId('voice-model-no-tools-warning')).toBeNull();

    fireEvent.change(modelSelect, { target: { value: 'qwen3-omni-flash-realtime' } });

    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.filter(([, action]) => action === 'set').at(-1);
      const payload = setCall![2] as { voice: { turnDetection: unknown; live: { conversationModel?: string; voiceId?: string } } };
      expect(payload.voice.live.conversationModel).toBe('qwen3-omni-flash-realtime');
      expect(payload.voice.live.voiceId).toBe('Cherry'); // Tina 是 3.5 独有，必须跟着回退
      // turnDetection 同写不分叉的契约在新 tab 一样成立
      expect(payload.voice.turnDetection).toMatchObject({ type: 'server_vad' });
    });
    expect(screen.getByTestId('voice-model-no-tools-warning').textContent).toBe(zh.voice.settings.modelNoToolsWarning);

    // 音色选择器的选项也跟着换成当前模型的白名单
    const voiceSelect = screen.getByTestId('voice-model-voice-id');
    const options = Array.from(voiceSelect.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['Cherry', 'Ethan', 'Serena']);
  });

  it('转写模型持久化到 speech.localModel（存储 key 不变）', async () => {
    settingsGet(undefined, { localModel: 'ggml-small.bin' } as AppSettings['speech']);
    render(<VoiceModelSettings />);
    const select = await screen.findByTestId('voice-model-transcription-model') as HTMLSelectElement;
    expect(select.value).toBe('ggml-small.bin');

    fireEvent.change(select, { target: { value: 'ggml-base.bin' } });
    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.filter(([, action]) => action === 'set').at(-1);
      const payload = setCall![2] as { speech: { localModel?: string } };
      expect(payload.speech.localModel).toBe('ggml-base.bin');
    });
  });
});

describe('搬家不是复制：三项已从原 tab 消失', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availability.configured = true;
  });
  afterEach(() => cleanup());

  it('voiceLive（实时语音）不再有通话模型与音色', async () => {
    settingsGet(undefined);
    render(<VoiceLiveSettingsSection />);
    await waitFor(() => expect(invokeDomainMock).toHaveBeenCalled());
    expect(screen.queryByTestId('voice-conversation-model')).toBeNull();
    expect(screen.queryByTestId('voice-provider-status')).toBeNull();
    expect(screen.queryByText(zh.voice.settings.voiceLabel)).toBeNull();
    // 使用偏好还在原 tab
    expect(screen.getByText(zh.voice.settings.interruptTitle)).toBeTruthy();
  });

  it('voiceInput（语音转文字）不再有转写模型', async () => {
    settingsGet(undefined);
    render(<VoiceInputSettings />);
    await waitFor(() => expect(invokeDomainMock).toHaveBeenCalled());
    expect(screen.queryByText(zh.settings.voiceInput.localModelLabel)).toBeNull();
    // 使用偏好还在原 tab
    expect(screen.getByText(zh.settings.voiceInput.modeTitle)).toBeTruthy();
  });
});

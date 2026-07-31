// @vitest-environment jsdom
//
// T1 + P1（2026-07-31）：「语音模型」tab 收拢 Provider / 通话模型 / 音色 / 转写模型。
// 本文件钉住三条验收：
//   1. 新 tab 在「模型与能力」组（与通用模型/多模态模型并列）；
//   2. 搬家不是复制——三项在原 voiceLive / voiceInput tab 已不存在；
//   3. voiceLive / voiceInput tab id 保留，深链落点不变（resolveSettingsDeepLink）。
// P1 新增：Provider 下拉联动、自定义 Provider 表单（测试通过才保存）、音色样音待生成。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AppSettings } from '../../../src/shared/contract';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
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

const BUILTIN_PROVIDERS = [
  {
    id: 'dashscope-qwen-omni',
    displayName: 'DashScope Qwen Omni',
    builtIn: true,
    configured: true,
    models: [
      { id: 'qwen3.5-omni-flash-realtime', displayName: 'qwen3.5-omni-flash-realtime', supportsTools: true, voices: ['Tina', 'Ethan', 'Serena'] },
      { id: 'qwen3-omni-flash-realtime', displayName: 'qwen3-omni-flash-realtime', supportsTools: false, voices: ['Cherry', 'Ethan', 'Serena'] },
    ],
    defaultModel: 'qwen3.5-omni-flash-realtime',
    defaultVoice: 'Tina',
    inputSampleRate: 16_000,
  },
  {
    id: 'openai-realtime',
    displayName: 'OpenAI Realtime',
    builtIn: true,
    configured: false,
    models: [
      { id: 'gpt-realtime-2.1', displayName: 'GPT Realtime 2.1', supportsTools: true, voices: ['marin', 'cedar', 'alloy'] },
    ],
    defaultModel: 'gpt-realtime-2.1',
    defaultVoice: 'marin',
    inputSampleRate: 24_000,
  },
];

function settingsGet(voice?: AppSettings['voice'], speech?: AppSettings['speech'], providers = BUILTIN_PROVIDERS) {
  invokeDomainMock.mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
      return Promise.resolve({ voice, speech } as AppSettings);
    }
    if (domain === IPC_DOMAINS.PROVIDER && action === 'list_realtime_voice_providers') {
      return Promise.resolve(providers);
    }
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

  it('渲染 Provider / 通话模型 / 音色 / 转写模型四项', async () => {
    settingsGet(undefined);
    render(<VoiceModelSettings />);
    expect(await screen.findByTestId('voice-provider-select')).toBeTruthy();
    expect(await screen.findByTestId('voice-conversation-model')).toBeTruthy();
    expect(screen.getByTestId('voice-model-voice-list')).toBeTruthy();
    expect(screen.getByTestId('voice-model-transcription-model')).toBeTruthy();
  });

  it('API Key 配置块常驻在语音模型 tab——配没配都展示，不是缺 key 才出现（批 X3 产品拍板）', async () => {
    settingsGet(undefined, undefined, BUILTIN_PROVIDERS);
    const { unmount } = render(<VoiceModelSettings />);
    // 已配：块在（收起成打码值形态）
    expect(await screen.findByTestId('voice-api-key-config')).toBeTruthy();
    expect(screen.getByTestId('voice-live-key-masked')).toBeTruthy();
    unmount();

    // 未配：块也在（展开成输入框形态）。configured 真相在 provider 列表里，不再走全局 hook
    const unconfiguredProviders = BUILTIN_PROVIDERS.map((p, i) => (i === 0 ? { ...p, configured: false } : p));
    settingsGet(undefined, undefined, unconfiguredProviders);
    render(<VoiceModelSettings />);
    expect(await screen.findByTestId('voice-api-key-config')).toBeTruthy();
    expect(screen.getByTestId('voice-live-key-input')).toBeTruthy();
  });

  it('Provider 已配置显示「已配置」，未配置显示引导文案', async () => {
    settingsGet(undefined, undefined, BUILTIN_PROVIDERS);
    const { unmount } = render(<VoiceModelSettings />);
    await waitFor(() => expect(screen.getByTestId('voice-provider-status').textContent).toBe(zh.voice.settings.providerConfigured));
    unmount();

    const unconfiguredProviders = BUILTIN_PROVIDERS.map((p, i) => (i === 0 ? { ...p, configured: false } : p));
    settingsGet(undefined, undefined, unconfiguredProviders);
    render(<VoiceModelSettings />);
    await waitFor(() => expect(screen.getByTestId('voice-provider-status').textContent).toBe(
      zh.voice.settings.providerMissing.replace('{name}', 'DashScope Qwen Omni'),
    ));
    expect(screen.getByTestId('voice-provider-missing-hint')).toBeTruthy();
  });

  it('切换 Provider 会持久化 providerId、conversationModel、voiceId 到 live', async () => {
    settingsGet(undefined);
    render(<VoiceModelSettings />);
    const providerSelect = await screen.findByTestId('voice-provider-select') as HTMLSelectElement;
    expect(providerSelect.value).toBe('dashscope-qwen-omni');

    fireEvent.change(providerSelect, { target: { value: 'openai-realtime' } });

    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.filter(([, action]) => action === 'set').at(-1);
      const payload = setCall![2] as { voice: { live: { providerId?: string; conversationModel?: string; voiceId?: string } } };
      expect(payload.voice.live.providerId).toBe('openai-realtime');
      expect(payload.voice.live.conversationModel).toBe('gpt-realtime-2.1');
      expect(payload.voice.live.voiceId).toBe('marin');
    });
  });

  it('API Key 说明随 Provider profile 切换：DashScope 共用 / OpenAI 复用 openai 槽 / 自定义隔离', async () => {
    const withCustom = [
      ...BUILTIN_PROVIDERS,
      {
        id: 'custom-acme',
        displayName: 'Acme Realtime',
        builtIn: false,
        configured: false,
        models: [
          { id: 'acme-1', displayName: 'acme-1', supportsTools: true, voices: ['ada'] },
        ],
        defaultModel: 'acme-1',
        defaultVoice: 'ada',
        inputSampleRate: 24_000 as const,
        endpoint: 'wss://voice.example.com/v1/realtime',
        authStyle: 'bearer' as const,
        sessionShape: 'openai-realtime' as const,
      },
    ];
    // 用 state 模拟切换 Provider 后 settings 持久化，使重新渲染读到新 live.providerId
    let liveProviderId: string | undefined;
    invokeDomainMock.mockImplementation((domain: string, action: string, payload?: unknown) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
        return Promise.resolve({
          voice: liveProviderId ? { live: { providerId: liveProviderId } } : {},
        } as AppSettings);
      }
      if (domain === IPC_DOMAINS.SETTINGS && action === 'set') {
        const next = payload as Partial<AppSettings>;
        liveProviderId = next.voice?.live?.providerId;
        return Promise.resolve(undefined);
      }
      if (domain === IPC_DOMAINS.PROVIDER && action === 'list_realtime_voice_providers') {
        return Promise.resolve(withCustom);
      }
      return Promise.resolve(undefined);
    });

    render(<VoiceModelSettings />);
    expect((await screen.findByTestId('voice-api-key-description')).textContent).toBe(
      zh.voice.settings.apiKeyDescription,
    );
    expect(screen.getByTestId('voice-api-key-description').textContent).toContain('图片生成');

    fireEvent.change(screen.getByTestId('voice-provider-select'), { target: { value: 'openai-realtime' } });
    await waitFor(() => {
      expect(screen.getByTestId('voice-api-key-description').textContent).toBe(
        zh.voice.settings.apiKeyDescriptionOpenAI,
      );
    });
    expect(screen.getByTestId('voice-api-key-description').textContent).not.toContain('图片生成');

    fireEvent.change(screen.getByTestId('voice-provider-select'), { target: { value: 'custom-acme' } });
    await waitFor(() => {
      expect(screen.getByTestId('voice-api-key-description').textContent).toBe(
        zh.voice.settings.apiKeyDescriptionCustom,
      );
    });
    expect(screen.getByTestId('voice-api-key-description').textContent).toContain('providerId');
  });

  it('音色选择器只出当前模型的实测白名单，且每个音色显示「样音待生成」', async () => {
    settingsGet(undefined);
    render(<VoiceModelSettings />);
    const list = await screen.findByTestId('voice-model-voice-list');
    const rows = Array.from(list.querySelectorAll('[data-testid^="voice-model-voice-"]'));
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'voice-model-voice-Tina',
      'voice-model-voice-Ethan',
      'voice-model-voice-Serena',
    ]);
    expect(list.textContent).toContain(zh.voice.settings.samplePending);
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
    const voiceList = screen.getByTestId('voice-model-voice-list');
    const rows = Array.from(voiceList.querySelectorAll('[data-testid^="voice-model-voice-"]'));
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'voice-model-voice-Cherry',
      'voice-model-voice-Ethan',
      'voice-model-voice-Serena',
    ]);
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

describe('回归测试：主审查四问题', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availability.configured = true;
  });
  afterEach(() => cleanup());

  it('issue 1: 保存自定义 Provider 后立即用 saved 结果持久化到新 provider', async () => {
    const saved = {
      id: 'custom-acme',
      displayName: 'Acme',
      endpoint: 'wss://voice.example.com/v1/realtime',
      authStyle: 'bearer',
      sessionShape: 'openai-realtime',
      model: 'acme-1',
      voices: ['ada'],
      defaultVoice: 'ada',
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
    };
    invokeDomainMock.mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
        return Promise.resolve({ voice: {} } as AppSettings);
      }
      if (domain === IPC_DOMAINS.PROVIDER && action === 'list_realtime_voice_providers') {
        return Promise.resolve(BUILTIN_PROVIDERS);
      }
      if (domain === IPC_DOMAINS.PROVIDER && action === 'test_realtime_voice_provider') {
        return Promise.resolve({ success: true });
      }
      if (domain === IPC_DOMAINS.PROVIDER && action === 'save_realtime_voice_provider') {
        return Promise.resolve(saved);
      }
      return Promise.resolve(undefined);
    });

    render(<VoiceModelSettings />);
    fireEvent.click(await screen.findByTestId('voice-add-provider'));
    fireEvent.change(screen.getByTestId('voice-add-provider-name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByTestId('voice-add-provider-endpoint'), { target: { value: 'wss://voice.example.com/v1/realtime' } });
    fireEvent.change(screen.getByTestId('voice-add-provider-key'), { target: { value: 'sk-acme' } });
    fireEvent.change(screen.getByTestId('voice-add-provider-model'), { target: { value: 'acme-1' } });
    fireEvent.change(screen.getByTestId('voice-add-provider-voices'), { target: { value: 'ada' } });
    fireEvent.click(screen.getByTestId('voice-add-provider-test'));
    await waitFor(() => expect(screen.getByTestId('voice-add-provider-test-status').textContent).toContain(
      zh.voice.settings.customProviderTestSuccess,
    ));
    fireEvent.click(screen.getByTestId('voice-add-provider-save'));

    await waitFor(() => {
      const setCalls = invokeDomainMock.mock.calls.filter(([, action]) => action === 'set');
      const liveSet = setCalls.find((call) => (call[2] as Partial<AppSettings>).voice?.live?.providerId === saved.id);
      expect(liveSet).toBeTruthy();
      const payload = liveSet![2] as { voice: { live: { providerId: string; conversationModel: string; voiceId: string } } };
      expect(payload.voice.live.providerId).toBe(saved.id);
      expect(payload.voice.live.conversationModel).toBe(saved.model);
      expect(payload.voice.live.voiceId).toBe(saved.defaultVoice);
    });

    await waitFor(() => {
      const listCalls = invokeDomainMock.mock.calls.filter(([, action]) => action === 'list_realtime_voice_providers');
      expect(listCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('issue 2: 切换 Provider 后 VoiceApiKeyConfig 的 draft/editor/masked 状态重置', async () => {
    settingsGet(undefined, undefined, BUILTIN_PROVIDERS);
    render(<VoiceModelSettings />);
    await waitFor(() => expect(screen.getByTestId('voice-live-key-masked')).toBeTruthy());
    fireEvent.click(screen.getByTestId('voice-live-key-change'));
    const input = await screen.findByTestId('voice-live-key-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'draft-key-should-not-leak' } });
    expect(input.value).toBe('draft-key-should-not-leak');

    const providerSelect = screen.getByTestId('voice-provider-select') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'openai-realtime' } });

    await waitFor(() => {
      const newInput = screen.queryByTestId('voice-live-key-input') as HTMLInputElement | null;
      if (newInput) {
        expect(newInput.value).toBe('');
      } else {
        expect(screen.queryByTestId('voice-live-key-masked')).toBeTruthy();
      }
    });
  });

  it('issue 3: badge 与 Key 块读取 provider 列表 configured，保存 Key 后刷新 provider 列表', async () => {
    availability.configured = true; // 全局 hook 说已配
    const unconfiguredProviders = BUILTIN_PROVIDERS.map((p, i) => (i === 0 ? { ...p, configured: false } : p));
    settingsGet(undefined, undefined, unconfiguredProviders);
    render(<VoiceModelSettings />);
    await waitFor(() => expect(screen.getByTestId('voice-provider-status').textContent).toBe(
      zh.voice.settings.providerMissing.replace('{name}', 'DashScope Qwen Omni'),
    ));
    expect(screen.getByTestId('voice-live-key-input')).toBeTruthy();

    fireEvent.change(screen.getByTestId('voice-live-key-input'), { target: { value: 'sk-dashscope-new' } });
    fireEvent.click(screen.getByTestId('voice-live-key-save'));

    await waitFor(() => {
      const listCalls = invokeDomainMock.mock.calls.filter(([, action]) => action === 'list_realtime_voice_providers');
      expect(listCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('issue 4: 添加 Provider 面板位于 Provider 行下方独立文档流', async () => {
    settingsGet(undefined, undefined, BUILTIN_PROVIDERS);
    render(<VoiceModelSettings />);
    fireEvent.click(await screen.findByTestId('voice-add-provider'));
    const panel = await screen.findByTestId('voice-add-provider-panel');
    const select = screen.getByTestId('voice-provider-select');
    expect(panel.parentElement).not.toBe(select.parentElement);
    expect(panel.parentElement).toBe(select.parentElement?.parentElement);
  });
});

describe('自定义 Provider 表单', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availability.configured = true;
    invokeDomainMock.mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
        return Promise.resolve({ voice: {} } as AppSettings);
      }
      if (domain === IPC_DOMAINS.PROVIDER && action === 'list_realtime_voice_providers') {
        return Promise.resolve(BUILTIN_PROVIDERS);
      }
      if (domain === IPC_DOMAINS.PROVIDER && action === 'test_realtime_voice_provider') {
        return Promise.resolve({ success: true });
      }
      if (domain === IPC_DOMAINS.PROVIDER && action === 'save_realtime_voice_provider') {
        return Promise.resolve({
          id: 'custom-acme',
          displayName: 'Acme',
          endpoint: 'wss://voice.example.com/v1/realtime',
          authStyle: 'bearer',
          sessionShape: 'openai-realtime',
          model: 'acme-1',
          voices: ['ada'],
          defaultVoice: 'ada',
          inputSampleRate: 16_000,
          outputSampleRate: 24_000,
        });
      }
      return Promise.resolve(undefined);
    });
  });
  afterEach(() => cleanup());

  it('打开添加 Provider 面板并渲染所有字段', async () => {
    render(<VoiceModelSettings />);
    fireEvent.click(await screen.findByTestId('voice-add-provider'));
    expect(await screen.findByTestId('voice-add-provider-panel')).toBeTruthy();
    expect(screen.getByTestId('voice-add-provider-name')).toBeTruthy();
    expect(screen.getByTestId('voice-add-provider-id')).toBeTruthy();
    expect(screen.getByTestId('voice-add-provider-endpoint')).toBeTruthy();
    expect(screen.getByTestId('voice-add-provider-key')).toBeTruthy();
    expect(screen.getByTestId('voice-add-provider-model')).toBeTruthy();
    expect(screen.getByTestId('voice-add-provider-voices')).toBeTruthy();
    expect(screen.getByTestId('voice-add-provider-rate')).toBeTruthy();
  });

  it('选择「需代码适配」路径后保存按钮禁用并显示说明', async () => {
    render(<VoiceModelSettings />);
    fireEvent.click(await screen.findByTestId('voice-add-provider'));
    fireEvent.click(screen.getByTestId('voice-add-provider-needs-code'));
    expect(screen.getByText(zh.voice.settings.customProviderNeedsCodeTitle)).toBeTruthy();
    expect((screen.getByTestId('voice-add-provider-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('鉴权方式选「其他」自动切到需代码适配态', async () => {
    render(<VoiceModelSettings />);
    fireEvent.click(await screen.findByTestId('voice-add-provider'));
    fireEvent.change(screen.getByTestId('voice-add-provider-auth'), { target: { value: 'other' } });
    expect(screen.getByText(zh.voice.settings.customProviderNeedsCodeTitle)).toBeTruthy();
  });

  it('测试通过后保存按钮可用，保存调用 save_realtime_voice_provider', async () => {
    render(<VoiceModelSettings />);
    fireEvent.click(await screen.findByTestId('voice-add-provider'));

    fireEvent.change(screen.getByTestId('voice-add-provider-name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByTestId('voice-add-provider-endpoint'), { target: { value: 'wss://voice.example.com/v1/realtime' } });
    fireEvent.change(screen.getByTestId('voice-add-provider-key'), { target: { value: 'sk-acme' } });
    fireEvent.change(screen.getByTestId('voice-add-provider-model'), { target: { value: 'acme-1' } });
    fireEvent.change(screen.getByTestId('voice-add-provider-voices'), { target: { value: 'ada' } });

    expect((screen.getByTestId('voice-add-provider-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('voice-add-provider-test'));
    await waitFor(() => expect(screen.getByTestId('voice-add-provider-test-status').textContent).toContain(
      zh.voice.settings.customProviderTestSuccess,
    ));
    expect((screen.getByTestId('voice-add-provider-save') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('voice-add-provider-save'));
    await waitFor(() => {
      expect(invokeDomainMock).toHaveBeenCalledWith(
        IPC_DOMAINS.PROVIDER,
        'save_realtime_voice_provider',
        expect.objectContaining({
          provider: expect.objectContaining({ id: 'custom-acme', model: 'acme-1' }),
          apiKey: 'sk-acme',
        }),
      );
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

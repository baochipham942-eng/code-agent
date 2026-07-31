// @vitest-environment jsdom
//
// DashScope API Key 配置块（批 X3）：常驻在「语音模型」tab，配没配都展示。
// 三条行为断言从 voiceLiveSettingsSection.test.tsx 原样迁来（组件搬家，语义不变）。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { VOICE_LIVE_SETTINGS_UPDATED_EVENT } from '../../../src/shared/contract/voice';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeDomainMock = vi.hoisted(() => vi.fn());
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

import { VoiceApiKeyConfig } from '../../../src/renderer/components/features/settings/tabs/VoiceApiKeyConfig';

describe('VoiceApiKeyConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeDomainMock.mockResolvedValue(undefined);
    availability.configured = true;
  });
  afterEach(() => cleanup());

  it('未配 key：输入框恒展开，保存写 dashscope 槽并广播设置刷新事件', async () => {
    availability.configured = false;
    const events: string[] = [];
    const listener = (event: Event) => events.push(event.type);
    window.addEventListener(VOICE_LIVE_SETTINGS_UPDATED_EVENT, listener);
    render(<VoiceApiKeyConfig />);

    const input = await screen.findByTestId('voice-live-key-input');
    // 空输入下保存按钮不可点（没什么可保存，也还没 key 可清）
    expect((screen.getByTestId('voice-live-key-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'sk-dashscope-1234567890' } });
    fireEvent.click(screen.getByTestId('voice-live-key-save'));
    await waitFor(() => {
      expect(invokeDomainMock).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'setServiceApiKey',
        { service: 'dashscope', apiKey: 'sk-dashscope-1234567890' },
      );
    });
    expect(events).toContain(VOICE_LIVE_SETTINGS_UPDATED_EVENT);
    window.removeEventListener(VOICE_LIVE_SETTINGS_UPDATED_EVENT, listener);
  });

  it('已配 key：显示已配置 + 更换；换 key 后收起成打码值', async () => {
    render(<VoiceApiKeyConfig />);

    // 已配默认收起：不渲染输入框，显示「已配置」+ 更换
    await waitFor(() => expect(screen.getByTestId('voice-live-key-masked')).toBeTruthy());
    expect(screen.queryByTestId('voice-live-key-input')).toBeNull();

    fireEvent.click(screen.getByTestId('voice-live-key-change'));
    const input = await screen.findByTestId('voice-live-key-input');
    fireEvent.change(input, { target: { value: 'sk-newkey-987654321' } });
    fireEvent.click(screen.getByTestId('voice-live-key-save'));
    await waitFor(() => {
      expect(invokeDomainMock).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'setServiceApiKey',
        { service: 'dashscope', apiKey: 'sk-newkey-987654321' },
      );
    });
    // 保存成功后就地收起成打码值，不整页 reload
    await waitFor(() => expect(screen.getByTestId('voice-live-key-masked').textContent).toBe('sk-newke...'));
    expect(screen.queryByTestId('voice-live-key-input')).toBeNull();
  });

  it('空串保存 = 清除：先过确认弹窗，确认后写空串清除', async () => {
    render(<VoiceApiKeyConfig />);

    fireEvent.click(await screen.findByTestId('voice-live-key-change'));
    // 已配状态下空输入点保存 = 请求清除
    fireEvent.click(screen.getByTestId('voice-live-key-save'));
    expect(await screen.findByText(zh.voice.settings.apiKeyClearTitle)).toBeTruthy();
    expect(invokeDomainMock).not.toHaveBeenCalledWith(
      IPC_DOMAINS.SETTINGS, 'setServiceApiKey', expect.anything(),
    );

    fireEvent.click(screen.getByText(zh.voice.settings.apiKeyClearConfirm));
    await waitFor(() => {
      expect(invokeDomainMock).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'setServiceApiKey',
        { service: 'dashscope', apiKey: '' },
      );
    });
  });

  it('传入 provider 时：标题与 service 槽都跟随该 Provider', async () => {
    render(<VoiceApiKeyConfig provider={{ displayName: 'OpenAI Realtime', service: 'openai' }} />);

    expect(await screen.findByText('OpenAI Realtime API Key')).toBeTruthy();
    fireEvent.click(screen.getByTestId('voice-live-key-change'));
    const input = await screen.findByTestId('voice-live-key-input');
    fireEvent.change(input, { target: { value: 'sk-openai-123' } });
    fireEvent.click(screen.getByTestId('voice-live-key-save'));
    await waitFor(() => {
      expect(invokeDomainMock).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'setServiceApiKey',
        { service: 'openai', apiKey: 'sk-openai-123' },
      );
    });
  });

  it('DashScope profile：说明保持「实时语音/图片/口述共用」', async () => {
    render(<VoiceApiKeyConfig />);
    expect((await screen.findByTestId('voice-api-key-description')).textContent).toBe(
      zh.voice.settings.apiKeyDescription,
    );
    expect(screen.getByTestId('voice-api-key-description').textContent).toContain('图片生成');
  });

  it('OpenAI profile：说明只谈复用 openai secure-storage 槽，不复用 DashScope 共用文案', async () => {
    render(
      <VoiceApiKeyConfig
        provider={{ displayName: 'OpenAI Realtime', service: 'openai', profile: 'openai' }}
      />,
    );
    const description = await screen.findByTestId('voice-api-key-description');
    expect(description.textContent).toBe(zh.voice.settings.apiKeyDescriptionOpenAI);
    expect(description.textContent).not.toContain('图片生成');
    expect(description.textContent).not.toContain('口述转写');
    expect(description.textContent).toContain('OpenAI Realtime');
    expect(description.textContent).toMatch(/secure-storage/i);
  });

  it('自定义 profile：说明 Key 按 providerId 隔离、原值不回传', async () => {
    render(
      <VoiceApiKeyConfig
        provider={{
          displayName: 'Acme Realtime',
          service: 'custom-realtime:custom-acme',
          profile: 'custom',
        }}
      />,
    );
    const description = await screen.findByTestId('voice-api-key-description');
    expect(description.textContent).toBe(zh.voice.settings.apiKeyDescriptionCustom);
    expect(description.textContent).toContain('providerId');
    expect(description.textContent).toContain('原值不回传');
    expect(description.textContent).not.toContain('图片生成');
  });

  it('未显式传 profile 时由 service 推导：openai 不落到 DashScope 共用说明', async () => {
    render(<VoiceApiKeyConfig provider={{ displayName: 'OpenAI Realtime', service: 'openai' }} />);
    const description = await screen.findByTestId('voice-api-key-description');
    expect(description.textContent).toBe(zh.voice.settings.apiKeyDescriptionOpenAI);
    expect(description.textContent).not.toBe(zh.voice.settings.apiKeyDescription);
  });

  it('configured prop 为 true 时收起，覆盖全局 hook 的 false', async () => {
    availability.configured = false;
    render(<VoiceApiKeyConfig provider={{ displayName: 'OpenAI', service: 'openai' }} configured />);
    await waitFor(() => expect(screen.getByTestId('voice-live-key-masked')).toBeTruthy());
    expect(screen.queryByTestId('voice-live-key-input')).toBeNull();
  });

  it('configured prop 为 false 时展开，覆盖全局 hook 的 true', async () => {
    availability.configured = true;
    render(<VoiceApiKeyConfig provider={{ displayName: 'OpenAI', service: 'openai' }} configured={false} />);
    expect(await screen.findByTestId('voice-live-key-input')).toBeTruthy();
  });

  it('保存 Key 成功后调用 onKeyChanged', async () => {
    const onKeyChanged = vi.fn();
    render(<VoiceApiKeyConfig provider={{ displayName: 'OpenAI', service: 'openai' }} configured={false} onKeyChanged={onKeyChanged} />);
    const input = await screen.findByTestId('voice-live-key-input');
    fireEvent.change(input, { target: { value: 'sk-openai' } });
    fireEvent.click(screen.getByTestId('voice-live-key-save'));
    await waitFor(() => expect(onKeyChanged).toHaveBeenCalledTimes(1));
  });

  it('清除 Key 成功后调用 onKeyChanged', async () => {
    const onKeyChanged = vi.fn();
    render(<VoiceApiKeyConfig provider={{ displayName: 'OpenAI', service: 'openai' }} configured onKeyChanged={onKeyChanged} />);
    fireEvent.click(await screen.findByTestId('voice-live-key-change'));
    fireEvent.click(screen.getByTestId('voice-live-key-save'));
    fireEvent.click(await screen.findByText(zh.voice.settings.apiKeyClearConfirm));
    await waitFor(() => expect(onKeyChanged).toHaveBeenCalledTimes(1));
  });
});

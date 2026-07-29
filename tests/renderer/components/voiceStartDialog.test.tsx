// @vitest-environment jsdom
//
// X2：拨号确认弹层内置音色选择（拨号前就地选，通话中热切换不做）。
// 钉三条：选项与设置页同源（当前通话模型的实测白名单，同一常量）、
// 变更即写回 voice.live.voiceId（走设置页同一条写路径，turnDetection 同写不分叉）、
// 保存后广播 VOICE_LIVE_SETTINGS_UPDATED_EVENT。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AppSettings } from '../../../src/shared/contract';
import { VOICE_LIVE_SETTINGS_UPDATED_EVENT } from '../../../src/shared/contract/voice';

const invokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomainMock(...args) },
}));

import { VoiceStartDialog } from '../../../src/renderer/components/features/voice/VoiceStartDialog';

function settingsGet(voice?: AppSettings['voice']) {
  invokeDomainMock.mockImplementation((_domain: string, action: string) => {
    if (action === 'get') return Promise.resolve({ voice } as AppSettings);
    return Promise.resolve(undefined);
  });
}

describe('VoiceStartDialog 音色就地选（X2）', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('渲染当前通话模型的音色白名单（与设置页同源），回显存量 voiceId', async () => {
    settingsGet({ live: { enabled: true, voiceId: 'Ethan' } });
    render(<VoiceStartDialog isOpen onConfirm={() => {}} onCancel={() => {}} />);
    const select = await screen.findByTestId('voice-start-voice-id') as HTMLSelectElement;
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.value)).toEqual(['Tina', 'Ethan', 'Serena']);
    expect(select.value).toBe('Ethan');
    expect(screen.getByText(zh.voice.settings.voiceLabel)).toBeTruthy();
  });

  it('变更音色即写回 voice.live.voiceId（turnDetection 同写）并广播设置更新事件', async () => {
    settingsGet({ live: { enabled: true, voiceId: 'Tina' } });
    const broadcast = vi.fn();
    window.addEventListener(VOICE_LIVE_SETTINGS_UPDATED_EVENT, broadcast);
    render(<VoiceStartDialog isOpen onConfirm={() => {}} onCancel={() => {}} />);
    const select = await screen.findByTestId('voice-start-voice-id');

    fireEvent.change(select, { target: { value: 'Ethan' } });

    await waitFor(() => {
      const setCall = invokeDomainMock.mock.calls.filter(([, action]) => action === 'set').at(-1);
      const payload = setCall![2] as { voice: { turnDetection: unknown; live: { voiceId?: string } } };
      expect(payload.voice.live.voiceId).toBe('Ethan');
      // 运行时真源 turnDetection 与 live 同写不分叉的契约同设置页
      expect(payload.voice.turnDetection).toMatchObject({ type: 'server_vad' });
    });
    expect(broadcast).toHaveBeenCalled();
  });

  it('存量 voiceId 不在当前模型白名单时落到第一个合法值（音色与模型强绑定）', async () => {
    settingsGet({ live: { enabled: true, conversationModel: 'qwen3-omni-flash-realtime', voiceId: 'Tina' } });
    render(<VoiceStartDialog isOpen onConfirm={() => {}} onCancel={() => {}} />);
    const select = await screen.findByTestId('voice-start-voice-id') as HTMLSelectElement;
    // Tina 是 3.5 系独有，上一代模型白名单里没有它
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.value)).toEqual(['Cherry', 'Ethan', 'Serena']);
    expect(select.value).toBe('Cherry');
  });
});

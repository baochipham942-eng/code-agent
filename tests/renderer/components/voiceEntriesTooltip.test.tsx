import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// G3 双语音入口 tooltip 双语义化（产品负责人 2026-07-27 拍板）：
// 波形 =「开始实时通话」（Voice：双工通话，音频上云），
// 麦克风 =「语音转文字」（Dictation：本地/云端转写进输入框）。
// 判据对齐 ChatGPT Voice vs Dictation——一个讲「通话」一个讲「转文字」，
// 用户一眼分清两条能力两种成本。此测试取代原 privacy 文案钉（旧的
// 「首次使用会请求麦克风」tooltip 被拍板文案取代；麦克风权限由首次
// 使用时的系统授权弹窗承担说明职责）。

vi.mock('../../../src/renderer/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    status: 'idle',
    duration: 0,
    isSupported: true,
    isEnabled: true,
    settings: { shortcut: '', mode: 'local-first', language: 'auto' },
    toggle: vi.fn(),
    error: null,
  }),
}));

const { VoiceInputButton } = await import('../../../src/renderer/components/features/chat/ChatInput/VoiceInputButton');
const { zh } = await import('../../../src/renderer/i18n/zh');
const { en } = await import('../../../src/renderer/i18n/en');

describe('双语音入口 tooltip 双语义化（G3）', () => {
  it('麦克风（Dictation）tooltip = 语音转文字', () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceInputButton, {
        onTranscript: vi.fn(),
      }),
    );

    expect(html).toContain('title="语音转文字"');
    expect(html).toContain('aria-label="语音转文字"');
    expect(html).not.toContain('Groq Whisper 转写');
  });

  it('波形（Voice）与麦克风文案分属两种语义，zh/en 同步', () => {
    expect(zh.voice.live.startTitle).toBe('开始实时通话');
    expect(en.voice.live.startTitle).toBe('Start a live call');
    expect(zh.voiceInputButton.idleTitle).toBe('语音转文字');
    expect(en.voiceInputButton.idleTitle).toBe('Voice to text');
    // 两种语义不得撞词：一个讲「通话」，一个讲「转文字」
    expect(zh.voice.live.startTitle).not.toBe(zh.voiceInputButton.idleTitle);
    expect(en.voice.live.startTitle).not.toBe(en.voiceInputButton.idleTitle);
  });
});

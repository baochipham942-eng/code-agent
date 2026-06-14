import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    status: 'idle',
    duration: 0,
    isSupported: true,
    toggle: vi.fn(),
    error: null,
  }),
}));

const { VoiceInputButton } = await import('../../../src/renderer/components/features/chat/ChatInput/VoiceInputButton');

describe('VoiceInputButton privacy copy', () => {
  it('explains microphone permission at the voice action point', () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceInputButton, {
        onTranscript: vi.fn(),
      }),
    );

    expect(html).toContain('首次使用会请求麦克风');
    expect(html).toContain('Groq Whisper 转写');
  });
});

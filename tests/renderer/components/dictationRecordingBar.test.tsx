// @vitest-environment jsdom
//
// DictationRecordingBar（G4 录音态输入行）行为门：
// - 计时恒为 m:ss（0:15 格式）；停止/发送按钮各回各的回调；
// - 波形由真实电平逐档驱动（level prop 采样成条），不造假动画；
// - prefers-reduced-motion 退化为静态电平条；
// - 转写中显示识别中、按钮禁用。
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

import {
  DictationRecordingBar,
  formatRecordingClock,
} from '../../../src/renderer/components/features/chat/ChatInput/DictationRecordingBar';

function renderBar(overrides: Record<string, unknown> = {}) {
  const props = {
    status: 'recording' as const,
    duration: 15,
    inputLevel: 0.4,
    silenceWarning: false,
    onStop: vi.fn(),
    onSend: vi.fn(),
    ...overrides,
  };
  const utils = render(<DictationRecordingBar {...props} />);
  return { ...utils, props };
}

afterEach(() => {
  cleanup();
});

describe('formatRecordingClock', () => {
  it('恒为 m:ss（0:15 格式）', () => {
    expect(formatRecordingClock(0)).toBe('0:00');
    expect(formatRecordingClock(15)).toBe('0:15');
    expect(formatRecordingClock(65)).toBe('1:05');
    expect(formatRecordingClock(600)).toBe('10:00');
  });
});

describe('DictationRecordingBar（G4）', () => {
  it('录音中：波形 + 0:15 计时 + 停止/发送按钮', () => {
    renderBar({ duration: 15 });
    expect(screen.getByTestId('dictation-recording-clock').textContent).toBe('0:15');
    expect(screen.getByTestId('dictation-waveform')).toBeTruthy();
    expect(screen.getByRole('button', { name: zh.voiceInputButton.stopRecordingAria })).toBeTruthy();
    expect(screen.getByRole('button', { name: zh.voiceInputButton.sendRecordingTitle })).toBeTruthy();
  });

  it('停止/发送按钮分别触发 onStop/onSend', () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: zh.voiceInputButton.stopRecordingAria }));
    expect(props.onStop).toHaveBeenCalledTimes(1);
    expect(props.onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: zh.voiceInputButton.sendRecordingTitle }));
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  it('波形条来自真实电平采样（level prop 驱动，非假动画）', () => {
    const { rerender, props } = renderBar({ inputLevel: 0 });
    // 初始一档 0 → 全是最低高度 12%
    let bars = screen.getByTestId('dictation-waveform').querySelectorAll('span');
    expect(bars.length).toBe(1);
    expect(bars[0].style.height).toBe('12%');

    rerender(<DictationRecordingBar {...props} inputLevel={0.8} />);
    bars = screen.getByTestId('dictation-waveform').querySelectorAll('span');
    expect(bars.length).toBe(2);
    expect(bars[1].style.height).toBe('80%');
  });

  it('prefers-reduced-motion：退化为静态电平条（无逐档波形）', () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      renderBar({ inputLevel: 0.42 });
      const staticBar = screen.getByTestId('dictation-waveform-static');
      expect(staticBar).toBeTruthy();
      expect(screen.queryByTestId('dictation-waveform')).toBeNull();
      const fill = staticBar.querySelectorAll('div');
      expect(fill[fill.length - 1].style.width).toBe('42%');
    } finally {
      window.matchMedia = original;
    }
  });

  it('转写中：显示识别中，无波形，按钮禁用', () => {
    renderBar({ status: 'transcribing' });
    expect(screen.getByText(zh.voiceInputButton.transcribingTitle)).toBeTruthy();
    expect(screen.queryByTestId('dictation-waveform')).toBeNull();
    expect(
      (screen.getByRole('button', { name: zh.voiceInputButton.stopRecordingAria }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: zh.voiceInputButton.sendRecordingTitle }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('ChatInput Dictation 接线（G4）', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/features/chat/ChatInput/index.tsx'),
    'utf8',
  );

  it('hook 提到 ChatInput 层，录音条与语音按钮共享同一路 voice 状态', () => {
    expect(source).toContain('const voice = useVoiceInput({');
    expect(source).toContain('<VoiceInputButton');
    expect(source).toContain('voice={voice}');
    expect(source).toContain('<DictationRecordingBar');
  });

  it('发送按钮 = 停止录音 + 转写完成后自动提交（send-after-transcript）', () => {
    expect(source).toContain('dictationSendAfterTranscriptRef.current = true;');
    expect(source).toContain("handleSubmitRef.current(undefined, { content: merged })");
  });
});

// @vitest-environment jsdom
//
// 设置 → 语音「语音转文字」组：词表本地清洗与 100 条上限。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AppSettings } from '../../../src/shared/contract';
import { VOICE_VOCABULARY_MAX_ENTRIES } from '../../../src/shared/constants/voice';

const invokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomainMock(...args) },
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { VoiceInputSettings, cleanVocabularyInput } from '../../../src/renderer/components/features/settings/tabs/VoiceInputSettings';

function settingsGet(voice?: Partial<AppSettings['voice']>, speech?: AppSettings['speech']) {
  invokeDomainMock.mockImplementation((_domain: string, action: string) => {
    if (action === 'get') {
      return Promise.resolve({
        speech,
        voice,
      } as AppSettings);
    }
    return Promise.resolve(undefined);
  });
}

describe('VoiceInputSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it('加载时清洗已有词表并显示有效条数', async () => {
    settingsGet({ vocabulary: ['  foo  ', '', 'bar', 'foo', 'a'.repeat(50)] });
    render(<VoiceInputSettings />);
    const textarea = await screen.findByTestId('voice-vocabulary');
    expect((textarea as HTMLTextAreaElement).value).toBe('foo\nbar');
    const count = await screen.findByTestId('voice-vocabulary-count');
    expect(count.textContent).toContain('2/100');
  });

  it('onChange 只更新原文与计数，不持久化', async () => {
    settingsGet();
    render(<VoiceInputSettings />);
    const textarea = await screen.findByTestId('voice-vocabulary');

    fireEvent.change(textarea, { target: { value: 'first' } });
    fireEvent.change(textarea, { target: { value: 'second\nthird' } });
    fireEvent.change(textarea, { target: { value: '  alpha  \nbeta\n\nalpha\n' + 'x'.repeat(41) + '\ngamma' } });

    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toContain('alpha'));
    expect(invokeDomainMock.mock.calls.some(([, action]) => action === 'set')).toBe(false);

    const count = await screen.findByTestId('voice-vocabulary-count');
    expect(count.textContent).toContain('3/100');
  });

  it('onBlur 时归一为清洗后的一行一项并仅保存一次 voice.vocabulary', async () => {
    settingsGet();
    render(<VoiceInputSettings />);
    const textarea = await screen.findByTestId('voice-vocabulary');

    fireEvent.change(textarea, {
      target: { value: ['  alpha  ', 'beta', '', 'alpha', 'x'.repeat(41), 'gamma'].join('\n') },
    });
    fireEvent.blur(textarea);

    await waitFor(() => {
      const setCalls = invokeDomainMock.mock.calls.filter(([, action]) => action === 'set');
      expect(setCalls).toHaveLength(1);
      const payload = setCalls[0][2] as Partial<AppSettings>;
      expect(payload.voice?.vocabulary).toEqual(['alpha', 'beta', 'gamma']);
    });

    expect((textarea as HTMLTextAreaElement).value).toBe('alpha\nbeta\ngamma');
  });

  it('blur 时应用 100 条上限并归一文本', async () => {
    settingsGet();
    render(<VoiceInputSettings />);
    const textarea = await screen.findByTestId('voice-vocabulary');

    const lines = Array.from({ length: VOICE_VOCABULARY_MAX_ENTRIES + 10 }, (_, i) => `term-${i}`);
    fireEvent.change(textarea, { target: { value: lines.join('\n') } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      const setCalls = invokeDomainMock.mock.calls.filter(([, action]) => action === 'set');
      expect(setCalls).toHaveLength(1);
      const payload = setCalls[0][2] as Partial<AppSettings>;
      expect(payload.voice?.vocabulary).toHaveLength(VOICE_VOCABULARY_MAX_ENTRIES);
    });

    const normalized = (textarea as HTMLTextAreaElement).value.split('\n');
    expect(normalized).toHaveLength(VOICE_VOCABULARY_MAX_ENTRIES);
  });

  it('cleanVocabularyInput 直接导出清洗规则', () => {
    expect(cleanVocabularyInput('a\n b \n\na\n' + 'c'.repeat(41) + '\nd')).toEqual(['a', 'b', 'd']);
    expect(cleanVocabularyInput(Array.from({ length: 105 }, (_, i) => `x${i}`).join('\n'))).toHaveLength(100);
  });
});

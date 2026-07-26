// @vitest-environment jsdom
//
// TranscriptPartialLine：partial 只在通话态临时渲染（§7.5）——idle 不渲染、
// 无 partial 不渲染、助手 partial 优先于用户 partial（barge-in 后用户打断）。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

import { TranscriptPartialLine } from '../../../src/renderer/components/features/voice/TranscriptPartialLine';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

describe('TranscriptPartialLine', () => {
  afterEach(() => {
    cleanup();
    useVoiceCallStore.getState().reset();
  });

  it('idle / live 但无 partial：不渲染', () => {
    const { container, unmount } = render(<TranscriptPartialLine />);
    expect(container.querySelector('[data-testid="voice-transcript-partial"]')).toBeNull();
    unmount();

    useVoiceCallStore.getState().dialStarted('s1', undefined, 'server_vad');
    useVoiceCallStore.getState().phaseChanged('live');
    const { container: c2 } = render(<TranscriptPartialLine />);
    expect(c2.querySelector('[data-testid="voice-transcript-partial"]')).toBeNull();
  });

  it('live + 用户 partial：显示「你：…」', () => {
    const store = useVoiceCallStore.getState();
    store.dialStarted('s1', undefined, 'server_vad');
    store.phaseChanged('live');
    store.eventApplied({ partialUser: '帮我看一下' });

    const { container } = render(<TranscriptPartialLine />);
    const line = container.querySelector('[data-testid="voice-transcript-partial"]');
    expect(line?.textContent).toContain('你');
    expect(line?.textContent).toContain('帮我看一下');
  });

  it('助手 partial 优先于用户 partial', () => {
    const store = useVoiceCallStore.getState();
    store.dialStarted('s1', undefined, 'server_vad');
    store.phaseChanged('live');
    store.eventApplied({ partialUser: '用户残留', partialAssistant: '正在回答' });

    const { container } = render(<TranscriptPartialLine />);
    const line = container.querySelector('[data-testid="voice-transcript-partial"]');
    expect(line?.textContent).toContain('助手');
    expect(line?.textContent).toContain('正在回答');
    expect(line?.textContent).not.toContain('用户残留');
  });
});

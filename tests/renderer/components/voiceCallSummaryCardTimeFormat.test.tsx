// @vitest-environment jsdom
// ============================================================================
// VoiceCallSummaryCard 字幕行时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// 展开字幕里每行的裸 toLocaleTimeString 改走 utils/formatDateTime(ts, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract/message';
import type { VoiceCallSummary } from '../../../src/shared/contract/voice';

import { VoiceCallSummaryCard } from '../../../src/renderer/components/features/voice/VoiceCallSummaryCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const LINE_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

const summary: VoiceCallSummary = {
  durationSec: 60,
  provider: 'qwen-omni',
  conversationModel: 'qwen3-omni-flash-realtime',
  workItemCount: 0,
  startedAt: LINE_AT - 30_000,
  endedAt: LINE_AT + 30_000,
};

afterEach(() => {
  cleanup();
  useSessionStore.setState({ messages: [] });
});

describe('VoiceCallSummaryCard 字幕行时间（跟随 UI language）', () => {
  it('zh UI：展开字幕的时间戳为 24 小时制带年份，无 AM/PM', () => {
    useAppStore.setState({ language: 'zh' });
    useSessionStore.setState({
      messages: [
        { id: 'm-1', role: 'user', content: '帮我看下构建', timestamp: LINE_AT, metadata: { source: 'voice' } } as Message,
      ],
    });
    render(<VoiceCallSummaryCard summary={summary} />);
    fireEvent.click(screen.getByRole('button'));
    const row = screen.getByText('帮我看下构建').closest('li');
    expect(row?.textContent).toContain(ZH);
    expect(document.body.textContent ?? '').not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', () => {
    useAppStore.setState({ language: 'en' });
    useSessionStore.setState({
      messages: [
        { id: 'm-1', role: 'user', content: 'check the build', timestamp: LINE_AT, metadata: { source: 'voice' } } as Message,
      ],
    });
    render(<VoiceCallSummaryCard summary={summary} />);
    fireEvent.click(screen.getByRole('button'));
    const row = screen.getByText('check the build').closest('li');
    expect(row?.textContent).toContain(EN);
    expect(row?.textContent).not.toContain('16:05');
  });
});

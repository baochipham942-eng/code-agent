// @vitest-environment jsdom
//
// VoiceCallSummaryCard 展开文字记录（G1）回归门：
// - 展开后内联列出本通电话时间窗内 source=voice 的字幕（说话人 + 文本）；
// - 时间窗外的 voice 消息、非 voice 消息、摘要自身（system）不混入；
// - 排水窗修复前的旧通话（窗内无字幕）展开后明示「未保留」，不装死；
// - 原生 button 承载展开（Enter/Space 键盘可操作），aria-expanded 同步。
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { Message } from '../../../src/shared/contract/message';
import type { VoiceCallSummary } from '../../../src/shared/contract/voice';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

import { VoiceCallSummaryCard } from '../../../src/renderer/components/features/voice/VoiceCallSummaryCard';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const START = 1_000_000;
const END = 1_060_000;

const summary: VoiceCallSummary = {
  durationSec: 60,
  provider: 'qwen-omni',
  conversationModel: 'qwen3-omni-flash-realtime',
  workItemCount: 0,
  startedAt: START,
  endedAt: END,
};

function msg(overrides: Partial<Message> & Pick<Message, 'id' | 'role' | 'timestamp'>): Message {
  return { content: 'text', ...overrides };
}

afterEach(() => {
  cleanup();
  useSessionStore.setState({ messages: [] });
});

describe('VoiceCallSummaryCard 展开文字记录（G1）', () => {
  it('展开后只列本通电话时间窗内的 voice 字幕', () => {
    useSessionStore.setState({
      messages: [
        msg({ id: 'm-in-user', role: 'user', content: '帮我看下构建', timestamp: START + 1_000, metadata: { source: 'voice' } }),
        msg({ id: 'm-in-asst', role: 'assistant', content: '构建通过了', timestamp: END - 1_000, metadata: { source: 'voice' } }),
        // 摘要自身（system + voiceCallSummary）：role 过滤天然排除
        msg({ id: 'm-summary', role: 'system', content: '语音通话结束', timestamp: END, metadata: { source: 'voice', voiceCallSummary: summary } }),
        // 时间窗外的 voice 消息（上一通/下一通电话）
        msg({ id: 'm-out-before', role: 'user', content: '上一通电话', timestamp: START - 1_000, metadata: { source: 'voice' } }),
        msg({ id: 'm-out-after', role: 'assistant', content: '下一通电话', timestamp: END + 1_000, metadata: { source: 'voice' } }),
        // 窗内但非 voice 来源（打字消息）
        msg({ id: 'm-typed', role: 'user', content: '打字的消息', timestamp: START + 2_000 }),
      ],
    });

    render(<VoiceCallSummaryCard summary={summary} />);
    const toggle = screen.getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('帮我看下构建')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('帮我看下构建')).toBeTruthy();
    expect(screen.getByText('构建通过了')).toBeTruthy();
    expect(screen.getByText(zh.voice.transcript.you)).toBeTruthy();
    expect(screen.getByText(zh.voice.transcript.assistant)).toBeTruthy();

    expect(screen.queryByText('上一通电话')).toBeNull();
    expect(screen.queryByText('下一通电话')).toBeNull();
    expect(screen.queryByText('打字的消息')).toBeNull();
    expect(screen.queryByText('语音通话结束')).toBeNull();
  });

  it('旧版本通话（窗内无字幕）展开后明示未保留，不空白', () => {
    useSessionStore.setState({
      messages: [
        msg({ id: 'm-summary', role: 'system', content: '语音通话结束', timestamp: END, metadata: { source: 'voice', voiceCallSummary: summary } }),
      ],
    });

    render(<VoiceCallSummaryCard summary={summary} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(zh.voice.call.noTranscriptLegacy)).toBeTruthy();
  });

  it('再次点击收起', () => {
    useSessionStore.setState({
      messages: [
        msg({ id: 'm-in-user', role: 'user', content: '帮我看下构建', timestamp: START + 1_000, metadata: { source: 'voice' } }),
      ],
    });

    render(<VoiceCallSummaryCard summary={summary} />);
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);
    expect(screen.getByText('帮我看下构建')).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('帮我看下构建')).toBeNull();
  });
});

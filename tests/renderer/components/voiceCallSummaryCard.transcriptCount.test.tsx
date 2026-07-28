// @vitest-environment jsdom
//
// VoiceCallSummaryCard 空字幕三档归因（2026-07-28 工单）回归门：
// 展开后窗内筛不到字幕时，按 summary.transcriptCount 分三档，不再一律赖给旧版本——
// - transcriptCount 缺失 → 真·旧记录，显示「未保留（旧版本通话）」；
// - transcriptCount === 0 → 新通话且本来就没说话，显示「没有对话内容」；
// - transcriptCount > 0 但窗内筛不到 → 有落库但当前会话找不到，显示「未保留」且不含「旧版本」。
// 第三条断言写成「渲染文本不含『旧版本』」：文案微调不红，归因错了必红。
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

function summary(overrides: Partial<VoiceCallSummary> = {}): VoiceCallSummary {
  return {
    durationSec: 60,
    provider: 'qwen-omni',
    conversationModel: 'qwen3-omni-flash-realtime',
    workItemCount: 0,
    startedAt: START,
    endedAt: END,
    ...overrides,
  };
}

function msg(overrides: Partial<Message> & Pick<Message, 'id' | 'role' | 'timestamp'>): Message {
  return { content: 'text', ...overrides };
}

/** 展开卡片并返回展开区里的提示文本（空字幕时唯一一段 italic 提示）。 */
function expandAndGetNotice(s: VoiceCallSummary): string {
  render(<VoiceCallSummaryCard summary={s} />);
  fireEvent.click(screen.getByRole('button'));
  const card = screen.getByTestId('voice-call-summary-card');
  const notice = card.querySelector('p');
  expect(notice).not.toBeNull();
  return notice!.textContent ?? '';
}

afterEach(() => {
  cleanup();
  useSessionStore.setState({ messages: [] });
});

describe('VoiceCallSummaryCard 空字幕三档归因', () => {
  it('transcriptCount 缺失（旧记录）→ 显示「未保留（旧版本通话）」', () => {
    // 旧版本通话的摘要里没有 transcriptCount 字段——字段缺失本身就是判据
    const s = summary();
    useSessionStore.setState({
      messages: [
        msg({ id: 'm-summary', role: 'system', content: '语音通话结束', timestamp: END, metadata: { source: 'voice', voiceCallSummary: s } }),
      ],
    });

    const notice = expandAndGetNotice(s);
    expect(notice).toBe(zh.voice.call.noTranscriptLegacy);
    expect(notice).toContain('旧版本');
  });

  it('transcriptCount === 0（拨通没说话）→ 显示「没有对话内容」，不赖旧版本', () => {
    const s = summary({ transcriptCount: 0 });
    useSessionStore.setState({ messages: [] });

    const notice = expandAndGetNotice(s);
    expect(notice).toBe(zh.voice.call.noTranscriptEmpty);
    expect(notice).not.toContain('旧版本');
  });

  it('transcriptCount > 0 但窗内筛不到 → 显示「未保留」且不含「旧版本」', () => {
    const s = summary({ transcriptCount: 2 });
    // store 里没有任何落在本通电话时间窗内的 voice 消息
    useSessionStore.setState({
      messages: [
        msg({ id: 'm-other', role: 'user', content: '别通电话', timestamp: START - 1_000, metadata: { source: 'voice' } }),
      ],
    });

    const notice = expandAndGetNotice(s);
    expect(notice).toBe(zh.voice.call.noTranscriptMissing);
    expect(notice).not.toContain('旧版本');
  });
});

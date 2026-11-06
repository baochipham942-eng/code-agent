// @vitest-environment jsdom
// ============================================================================
// VoiceAuditDialog 通话清单开始时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// 清单行的裸 toLocaleString 改走 utils/formatDateTime(startedAt, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// ============================================================================
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VoiceAuditDialog } from '../../../src/renderer/components/features/voice/VoiceAuditDialog';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const STARTED_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

const call = {
  voiceCallId: 'voice-a',
  summaryMessageId: 'summary-a',
  neoSessionId: 'session-a',
  summary: {
    durationSec: 12,
    provider: 'qwen-omni',
    conversationModel: 'qwen3.5-omni-flash-realtime',
    workItemCount: 1,
    startedAt: STARTED_AT,
    endedAt: STARTED_AT + 12_000,
  },
};

function makeTimeline() {
  return {
    call,
    sections: {
      transcript: { status: 'none', note: '无字幕', events: [] },
      decisions: { status: 'unavailable', note: '无法查询', events: [] },
      sayDo: { status: 'none', note: '没有干预', events: [] },
      dispatches: { status: 'ok', events: [] },
      approvals: { status: 'none', note: '没有审批', events: [] },
      outcomes: { status: 'none', note: '无留痕', events: [] },
    },
    cost: { status: 'unavailable', note: '未存 token', durationSec: 12 },
    recording: { status: 'unavailable', note: '未开启录音', files: [] },
  };
}

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => payload } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('VoiceAuditDialog 通话清单时间（跟随 UI language）', () => {
  it('zh UI：清单行开始时间为 24 小时制带年份，无 AM/PM', async () => {
    useAppStore.setState({ language: 'zh' });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
      String(input).includes('/timeline')
        ? jsonResponse(makeTimeline())
        : jsonResponse({ calls: [call] })
    )));
    render(<VoiceAuditDialog sessionId="session-a" onClose={vi.fn()} />);
    await screen.findByTestId('voice-audit-timeline');
    await waitFor(() => {
      expect(screen.getByTestId('voice-audit-call-voice-a').textContent).toContain(ZH);
    });
    expect(screen.getByTestId('voice-audit-call-voice-a').textContent).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
      String(input).includes('/timeline')
        ? jsonResponse(makeTimeline())
        : jsonResponse({ calls: [call] })
    )));
    render(<VoiceAuditDialog sessionId="session-a" onClose={vi.fn()} />);
    await screen.findByTestId('voice-audit-timeline');
    await waitFor(() => {
      expect(screen.getByTestId('voice-audit-call-voice-a').textContent).toContain(EN);
    });
    expect(screen.getByTestId('voice-audit-call-voice-a').textContent).not.toContain('16:05');
  });
});

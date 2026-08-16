// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  filterVoiceCallsForSession,
  VoiceAuditDialog,
  type VoiceCallListItem,
  type VoiceCallTimeline,
} from '../../../src/renderer/components/features/voice/VoiceAuditDialog';

const callA: VoiceCallListItem = {
  voiceCallId: 'voice-a',
  summaryMessageId: 'summary-a',
  neoSessionId: 'session-a',
  summary: {
    durationSec: 12,
    provider: 'qwen-omni',
    conversationModel: 'qwen3.5-omni-flash-realtime',
    workItemCount: 1,
    startedAt: 200,
    endedAt: 12_200,
  },
};

const callB: VoiceCallListItem = {
  ...callA,
  voiceCallId: null,
  summaryMessageId: 'summary-b',
  neoSessionId: 'session-b',
  summary: { ...callA.summary, startedAt: 300 },
};

function makeTimeline(): VoiceCallTimeline {
  return {
    call: callA,
    sections: {
      transcript: { status: 'none', note: '字幕账已查，无字幕', events: [] },
      decisions: { status: 'unavailable', note: '日志已轮转，无法查询', events: [] },
      sayDo: { status: 'none', note: '日志在，确实没有干预', events: [] },
      dispatches: {
        status: 'ok',
        events: [{ at: 400, title: '审计派单', origin: 'host_routed', keyMatch: 'exact' }],
      },
      approvals: { status: 'none', note: '没有审批', events: [] },
      outcomes: { status: 'none', note: '无失败留痕、无结局印章', events: [] },
    },
    cost: { status: 'unavailable', note: '旧记录未存单通 token', durationSec: 12 },
    recording: { status: 'unavailable', note: '本通电话未开启录音', files: [] },
  };
}

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => payload } as Response;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:voice-audit'),
    revokeObjectURL: vi.fn(),
  });
});

describe('VoiceAuditDialog', () => {
  it('按 neoSessionId 过滤并按开始时间倒序', () => {
    const older = { ...callA, voiceCallId: 'voice-older', summary: { ...callA.summary, startedAt: 100 } };
    expect(filterVoiceCallsForSession([older, callB, callA], 'session-a').map((call) => call.voiceCallId))
      .toEqual(['voice-a', 'voice-older']);
  });

  it('非通话会话显示明确空态', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ calls: [callB] })));
    render(<VoiceAuditDialog sessionId="session-a" onClose={vi.fn()} />);
    expect((await screen.findByTestId('voice-audit-empty')).textContent).toContain('本会话无语音通话');
  });

  it('none 与 unavailable 使用不同状态和后端 note', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes('/timeline') ? jsonResponse(makeTimeline()) : jsonResponse({ calls: [callA] });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<VoiceAuditDialog sessionId="session-a" onClose={vi.fn()} />);

    await screen.findByTestId('voice-audit-timeline');
    expect(screen.getAllByTestId('voice-audit-status-none').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('voice-audit-status-unavailable').length).toBeGreaterThan(0);
    expect(screen.getByText('字幕账已查，无字幕')).toBeTruthy();
    expect(screen.getByText('日志已轮转，无法查询')).toBeTruthy();
    expect(screen.getByText('本通电话未开启录音')).toBeTruthy();
    expect(screen.getByText('Host 路由')).toBeTruthy();
  });

  it('导出调用当前通话 markdown 端点', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('format=markdown')) {
        return { ok: true, status: 200, statusText: 'OK', text: async () => '# 语音通话审计时间线' } as Response;
      }
      return url.includes('/timeline') ? jsonResponse(makeTimeline()) : jsonResponse({ calls: [callA] });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<VoiceAuditDialog sessionId="session-a" onClose={vi.fn()} />);

    await screen.findByTestId('voice-audit-timeline');
    fireEvent.click(screen.getByRole('button', { name: '导出 Markdown' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/voice/calls/voice-a/timeline?format=markdown'));
    });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });
});

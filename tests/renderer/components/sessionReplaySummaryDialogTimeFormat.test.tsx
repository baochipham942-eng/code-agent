// ============================================================================
// SessionReplaySummaryDialog 两处内联事件时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// 聚焦任务/历史列表里 event.timestamp 的裸 toLocaleTimeString 改走
// utils/formatDateTime(ts, language)，zh 24 小时制带年份、绝不跟机器 locale 出
// AM/PM；en 维持 en-US 原样。（formatTaskEventDetail 等 helper 已由
// sessionReplayFormattersTimeFormat.test.ts 钉档，这里补对话框本体。）
// ============================================================================
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SessionReplaySummaryDialog } from '../../../src/renderer/components/features/sidebar/SessionReplaySummaryDialog';
import type { Task } from '@shared/contract/backgroundTask';

// renderToStaticMarkup（服务端渲染路径）下 zustand 的 getServerSnapshot 返回初始
// state，useAppStore.setState 影响不到静态渲染——改 mock useI18n 定桩 language
// （同 projectCollaborationDetailPaneTime.test.tsx 的做法）。
const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({ t: i18nState.language === 'zh' ? zh : en, language: i18nState.language }),
  };
});

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const EVENT_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

const BACKGROUND_TASK: Task = {
  id: 'task-1',
  sessionId: 'session-1',
  source: 'agent',
  title: 'Background delivery',
  status: 'completed',
  createdAt: EVENT_AT,
  updatedAt: EVENT_AT,
  durationMs: 2500,
  events: [
    {
      id: 'event-1',
      taskId: 'task-1',
      type: 'task_started',
      status: 'running',
      message: 'running background delivery',
      timestamp: EVENT_AT,
    },
    {
      id: 'event-2',
      taskId: 'task-1',
      type: 'output_added',
      status: 'completed',
      message: 'trace file written',
      timestamp: EVENT_AT,
    },
  ],
  outputRefs: [],
};

function renderDialog(): string {
  return renderToStaticMarkup(
    <SessionReplaySummaryDialog
      sessionTitle="Session / Replay"
      onClose={vi.fn()}
      onOpenEvidence={vi.fn()}
      replay={{
        sessionId: 'session-1',
        traceSource: 'session_replay',
        traceIdentity: {
          traceId: 'session:session-1',
          traceSource: 'session_replay',
          source: 'session_replay',
          sessionId: 'session-1',
          replayKey: 'session-1',
        },
        dataSource: 'transcript_fallback',
        turns: [],
        summary: {
          totalTurns: 0,
          toolDistribution: {
            Read: 0,
            Edit: 0,
            Write: 0,
            Bash: 0,
            Search: 0,
            Web: 0,
            Agent: 0,
            Skill: 0,
            Other: 0,
          },
          thinkingRatio: 0,
          selfRepairChains: 0,
          totalDurationMs: 0,
        },
      }}
      workflowRuns={[]}
      backgroundTasks={[BACKGROUND_TASK]}
      evidence={[]}
    />,
  );
}

describe('SessionReplaySummaryDialog 内联事件时间（跟随 UI language）', () => {
  it('zh UI：事件时间为 24 小时制带年份，无 AM/PM', () => {
    i18nState.language = 'zh';
    const html = renderDialog();
    expect(html).toContain('Background delivery');
    expect(html).toContain(ZH);
    expect(html).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', () => {
    i18nState.language = 'en';
    const html = renderDialog();
    expect(html).toContain(EN);
    expect(html).not.toContain('16:05');
  });
});

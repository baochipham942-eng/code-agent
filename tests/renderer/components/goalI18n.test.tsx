import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GoalNoticeMessage } from '../../../src/renderer/components/features/chat/MessageBubble/GoalNoticeMessage';
import { GoalStatusBarView } from '../../../src/renderer/components/features/chat/GoalStatusBar';
import { encodeGoalNotice } from '../../../src/renderer/components/features/chat/goalNotice';
import type { GoalRunState } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

describe('goal UI 文案 i18n（zh/en 对齐，不再硬编码）', () => {
  it('GoalNoticeMessage 三态前缀走 i18n 键', () => {
    const start = renderToStaticMarkup(
      <GoalNoticeMessage content={encodeGoalNotice({ kind: 'start', goal: 'g1' })} />,
    );
    expect(start).toContain(zh.goalNotice.startPrefix);

    const met = renderToStaticMarkup(
      <GoalNoticeMessage content={encodeGoalNotice({ kind: 'met', goal: 'g2', durationMs: 65_000, turns: 3 })} />,
    );
    expect(met).toContain(zh.goalNotice.metPrefix);
    expect(met).toContain(`${zh.goalNotice.durationPrefix}1m 5s`);
    expect(met).toContain(`3${zh.goalNotice.turnsSuffix}`);

    const aborted = renderToStaticMarkup(
      <GoalNoticeMessage content={encodeGoalNotice({ kind: 'aborted', goal: 'g3', reason: 'r' })} />,
    );
    expect(aborted).toContain(zh.goalNotice.abortedPrefix);
  });

  it('GoalStatusBar 运行态/暂停态/闸提示走 i18n 键', () => {
    const baseRun = {
      goal: '修好构建',
      startedAt: Date.now() - 5000,
      turn: 2,
      maxTurns: 10,
      tokenBudget: 0,
      tokensUsed: 0,
    };
    const running = renderToStaticMarkup(
      <GoalStatusBarView
        run={{ ...baseRun, status: 'running', lastGate: { gate: 1, status: 'running' } } as GoalRunState}
        onTogglePause={() => {}}
      />,
    );
    expect(running).toContain(zh.goalStatusBar.runningPrefix);
    expect(running).toContain(zh.goalStatusBar.verifying);

    const paused = renderToStaticMarkup(
      <GoalStatusBarView run={{ ...baseRun, status: 'paused' } as GoalRunState} onTogglePause={() => {}} />,
    );
    expect(paused).toContain(zh.goalStatusBar.pausedPrefix);
  });

  it('goalNotice / goalStatusBar 的 zh/en 键对齐', () => {
    expect(Object.keys(en.goalNotice).sort()).toEqual(Object.keys(zh.goalNotice).sort());
    expect(Object.keys(en.goalStatusBar).sort()).toEqual(Object.keys(zh.goalStatusBar).sort());
  });
});

// @vitest-environment jsdom
// ============================================================================
// N-MEDIA-GEN-MUSIC-FALLBACK-FU1：delegate_task 回执行的终局工具失败出路。
// 主人决策（10-24 option 2）：后台任务收尾失败 / 模型放弃时，任务行要说清失败
// code 的中文摘要 + 出路。这里钉 DelegationReceipt：失败/带字段的 completed 亮
// 出路（含 {alternatives} 填充），运行中与无字段任务不亮。
// ============================================================================

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { ToolCall } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));

const openPreview = vi.fn();
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: { openPreview: typeof openPreview }) => unknown) => (
    selector({ openPreview })
  ),
}));

import { DelegationReceipt } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/DelegationReceipt';
import { deriveDelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';

const delegateCall: ToolCall = {
  id: 'call-delegate-1',
  name: 'delegate_task',
  arguments: { task: '给视频配背景音乐' },
  result: { toolCallId: 'call-delegate-1', success: true, output: '已派出任务 task-music' },
};

function musicTask(status: Task['status'], withFailure: boolean): Task {
  return {
    id: 'task-music',
    toolCallId: 'call-delegate-1',
    sessionId: 'session-1',
    source: 'delegate_task',
    title: '给视频配背景音乐',
    summary: '音乐生成失败，视频先交付了',
    status,
    createdAt: 1,
    updatedAt: 2,
    events: [],
    outputRefs: [],
    ...(withFailure
      ? {
        progress: {
          lastToolStep: { tool: 'music_generate', at: 2 },
          lastToolFailure: {
            tool: 'music_generate',
            code: 'MUSIC_SERVICE_UNAVAILABLE',
            alternatives: 'zhipu:glm-5.3',
            at: 2,
          },
        },
      }
      : {}),
  };
}

function renderReceipt(task: Task): void {
  const presentation = deriveDelegationPresentation(delegateCall, [task], []);
  expect(presentation).not.toBeNull();
  render(<DelegationReceipt presentation={presentation!} />);
}

afterEach(() => cleanup());

describe('DelegationReceipt — 终局工具失败出路', () => {
  it('失败任务的回执行亮中文摘要 + 出路，{alternatives} 已填', () => {
    renderReceipt(musicTask('failed', true));
    const note = screen.getByTestId('delegation-tool-failure');
    expect(note.textContent).toContain('默认音乐服务（MiniMax）已不可用');
    expect(note.textContent).toContain('可改用已配置的音乐模型：zhipu:glm-5.3');
  });

  it('模型放弃但任务 completed：字段仍在就亮出路', () => {
    renderReceipt(musicTask('completed', true));
    expect(screen.getByTestId('delegation-tool-failure').textContent)
      .toContain('可改用已配置的音乐模型：zhipu:glm-5.3');
  });

  it('运行中的任务走 activity 行，不亮出路', () => {
    renderReceipt(musicTask('running', true));
    expect(screen.getByTestId('delegation-activity')).toBeTruthy();
    expect(screen.queryByTestId('delegation-tool-failure')).toBeNull();
  });

  it('无 lastToolFailure 的终态任务回执不变：没有出路行', () => {
    renderReceipt(musicTask('failed', false));
    expect(screen.queryByTestId('delegation-tool-failure')).toBeNull();
    expect(screen.getByTestId('delegation-failure').textContent).toContain('音乐生成失败，视频先交付了');
  });
});

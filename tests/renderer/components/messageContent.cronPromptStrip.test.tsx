// @vitest-environment jsdom
// ============================================================================
// N-UI-CRON-RUN-RECORD-CLEAR：运行记录会话的用户气泡只显示任务本身。
// 存储里的消息内容仍是完整 prompt（模型必须收到全文），渲染层切掉机器尾段。
// ============================================================================

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';

const TASK = '查一下今天的日程，把冲突的会议列出来';
// buildCronAgentPrompt 产出的真实形状（旧记录同形）：任务 + 空行 + 时间锚点 + 摘要指令
const FULL_PROMPT = [
  TASK,
  '',
  '【当前时间】2026-11-04T08:27:33.512Z（UTC）。今天本地日期是 2026-11-04。'
    + '若要按「今天/本地当天」查询时间戳，直接用这两个算好的值，不要自己换算年份：'
    + '今天本地 00:00 = 1792761600（Unix 秒），次日本地 00:00 = 1792848000（Unix 秒）。',
  '',
  '最后请在回复末尾追加简短的 <cron_summary>...</cron_summary> 块：先写结果摘要；'
    + '每个生成的文件或可访问产物另起一行，格式为 artifact: <path>。',
].join('\n');

const ASSISTANT_WITH_CRON_BLOCKS = [
  'BG-PARKED-888',
  '',
  '<cron_snapshot>',
  'last_echo=BG-PARKED-888',
  '</cron_snapshot>',
  '',
  '<cron_summary>',
  'urgency: fyi',
  'shell 命令 echo BG-PARKED-888 已成功执行，输出为 BG-PARKED-888。',
  '</cron_summary>',
].join('\n');

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessions: [], currentSessionId: null });
});

describe('MessageContent 用户气泡的 cron prompt 切割', () => {
  it('带机器尾段的记录（新旧同形）：气泡只显示任务，不出现时间锚点与摘要指令', () => {
    const view = render(
      <MessageContent content={FULL_PROMPT} isUser messageId="cron-run-user-1" />,
    );
    expect(view.container.textContent).toContain(TASK);
    expect(view.container.textContent).not.toContain('【当前时间】');
    expect(view.container.textContent).not.toContain('cron_summary');
    expect(view.container.textContent).not.toContain('Unix 秒');
  });

  it('普通用户消息不受影响', () => {
    const plain = '帮我看看这个报错\n\n第二行';
    const view = render(
      <MessageContent content={plain} isUser messageId="plain-user-1" />,
    );
    expect(view.container.textContent).toContain('帮我看看这个报错');
    expect(view.container.textContent).toContain('第二行');
  });

  it('追问分支子会话（origin=manual，父会话为 cron 运行记录）：复制过来的助手回复同样渲染为「本次运行摘要」卡，不露出裸 <cron_summary> 与 urgency:', async () => {
    const parentSession = {
      id: 'cron-parent-1',
      title: '[Schedule] 每日日程检查',
      origin: { kind: 'cron' as const, id: 'job-1' },
      createdAt: 1000,
      updatedAt: 1000,
    } as Partial<SessionWithMeta> as SessionWithMeta;
    const childSession = {
      id: 'fork-child-1',
      title: '[Schedule] 每日日程检查 · 分支',
      origin: { kind: 'manual' as const, metadata: { forkId: 'fork-1' } },
      parentSessionId: 'cron-parent-1',
      metadata: {
        forkLineage: {
          forkId: 'fork-1',
          rootSessionId: 'cron-parent-1',
          parentSessionId: 'cron-parent-1',
          childSessionId: 'fork-child-1',
        },
      },
      createdAt: 2000,
      updatedAt: 2000,
    } as Partial<SessionWithMeta> as SessionWithMeta;
    useSessionStore.setState({
      sessions: [parentSession, childSession],
      currentSessionId: 'fork-child-1',
    });

    const view = render(
      <MessageContent
        content={ASSISTANT_WITH_CRON_BLOCKS}
        isUser={false}
        messageId="forked-assistant-1"
        mediaContext={{ sessionId: 'fork-child-1' }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('cron-run-summary')).toBeTruthy();
    });
    expect(screen.getByTestId('cron-run-summary').textContent).toContain('本次运行摘要');
    expect(screen.getByTestId('cron-run-summary').textContent).toContain('已成功执行');
    expect(view.container.textContent).not.toContain('cron_summary');
    expect(view.container.textContent).not.toContain('cron_snapshot');
    expect(view.container.textContent).not.toContain('last_echo=');
    expect(view.container.textContent).not.toContain('urgency:');
  });
});

// ============================================================================
// N-UI-CRON-RUN-RECORD-CLEAR：运行记录会话的用户气泡只显示任务本身。
// 存储里的消息内容仍是完整 prompt（模型必须收到全文），渲染层切掉机器尾段。
// ============================================================================

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkupAsync } from './renderToStaticMarkupAsync';

const { MessageContent } = await import(
  '../../../src/renderer/components/features/chat/MessageBubble/MessageContent'
);

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

describe('MessageContent 用户气泡的 cron prompt 切割', () => {
  it('带机器尾段的记录（新旧同形）：气泡只显示任务，不出现时间锚点与摘要指令', async () => {
    const html = await renderToStaticMarkupAsync(
      <MessageContent content={FULL_PROMPT} isUser messageId="cron-run-user-1" />,
    );
    expect(html).toContain(TASK);
    expect(html).not.toContain('【当前时间】');
    expect(html).not.toContain('cron_summary');
    expect(html).not.toContain('Unix 秒');
  });

  it('普通用户消息不受影响', async () => {
    const plain = '帮我看看这个报错\n\n第二行';
    const html = await renderToStaticMarkupAsync(
      <MessageContent content={plain} isUser messageId="plain-user-1" />,
    );
    expect(html).toContain('帮我看看这个报错');
    expect(html).toContain('第二行');
  });
});

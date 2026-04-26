import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityContextPreviewPanel } from '../../../src/renderer/components/features/settings/tabs/ScreenMemorySettings';

describe('ScreenMemorySettings ActivityContext preview', () => {
  it('renders compact recent context and agent injection previews without local paths', () => {
    const html = renderToStaticMarkup(React.createElement(ActivityContextPreviewPanel, {
      context: {
        capturedAtMs: 1_713_456_000_000,
        status: 'ready',
        recentContextSummary: '09:00-09:30 在 Cursor 处理屏幕记忆设置。',
        agentInjectionPreview: 'Use recent screen context as soft context only.',
        sources: [
          { kind: 'automatic_background', label: '自动后台', summary: '桌面活动摘要' },
          { kind: 'meeting_audio', label: '会议音频', summary: '会议转录摘要' },
          { kind: 'screenshot_analysis', label: '截图分析', summary: '截图语义摘要' },
        ],
        evidence: [
          '窗口: Cursor',
          '截图: [local path hidden]',
        ],
      },
    }));

    expect(html).toContain('最近上下文预览');
    expect(html).toContain('将注入 agent 的内容预览');
    expect(html).toContain('自动后台');
    expect(html).toContain('会议音频');
    expect(html).toContain('截图分析');
    expect(html).toContain('09:00-09:30 在 Cursor');
    expect(html).toContain('Use recent screen context as soft context only.');
    expect(html).not.toContain('/Users/linchen');
  });
});

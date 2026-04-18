import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionWorkspaceBar } from '../../../src/renderer/components/features/chat/SessionWorkspaceBar';

describe('SessionWorkspaceBar', () => {
  it('renders the minimal session actions when they are available', () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionWorkspaceBar, {
        title: '修 Phase 5',
        status: {
          kind: 'paused',
          label: '暂停',
          toneClassName: 'text-amber-300',
        },
        activityLabel: '5m',
        turnCount: 4,
        snapshot: {
          summary: '工作区 · Browser',
          labels: ['工作区', 'Browser'],
          recentToolNames: ['browser_action'],
        },
        workingDirectory: '/repo/code-agent',
        currentWorkingDirectory: '/repo/other',
        canResume: true,
        canMoveToBackground: true,
        onResume: () => {},
        onMoveToBackground: () => {},
        onExportMarkdown: () => {},
        onReopenWorkspace: () => {},
      }),
    );

    expect(html).toContain('修 Phase 5');
    expect(html).toContain('暂停');
    expect(html).toContain('4 轮');
    expect(html).toContain('工作区 · Browser');
    expect(html).toContain('恢复执行');
    expect(html).toContain('移到后台');
    expect(html).toContain('导出 Markdown');
    expect(html).toContain('恢复工作区');
  });
});

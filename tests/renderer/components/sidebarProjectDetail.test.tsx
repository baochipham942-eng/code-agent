import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SidebarProjectDetail } from '../../../src/renderer/components/features/sidebar/SidebarProjectDetail';

describe('SidebarProjectDetail', () => {
  it('renders project goals, artifacts, roles, and sessions as recovery context', () => {
    const html = renderToStaticMarkup(
      <SidebarProjectDetail
        fallbackSessionCount={2}
        onOpenArtifactSession={vi.fn()}
        onStartGoal={vi.fn()}
        meta={{
          name: 'code-agent',
          status: 'active',
          description: 'Alma 对标项目',
          goalCount: 3,
          activeGoalTitles: ['补齐会话组织', '收口 Review Queue'],
          goals: [
            { id: 'goal-1', title: '补齐会话组织', status: 'active', updatedAt: 3, lastRunSessionId: 'session-goal-1' },
            { id: 'goal-2', title: '收口 Review Queue', status: 'met', updatedAt: 2 },
            { id: 'goal-3', title: '清理旧入口', status: 'aborted', updatedAt: 1 },
          ],
          roleCount: 2,
          roleIds: ['researcher', 'reviewer'],
          artifactCount: 4,
          recentArtifactTitles: ['研究文档', '验收报告'],
          recentArtifacts: [
            { id: 'artifact-doc-1', sessionId: 'session-artifact-1', messageId: 'message-1', title: '研究文档', kind: 'document', sessionTitle: 'Alma 研究', createdAt: 4 },
            { id: 'artifact-sheet-1', sessionId: 'session-artifact-2', messageId: 'message-2', title: '验收报告', kind: 'spreadsheet', sessionTitle: 'QA 会话', createdAt: 3 },
          ],
          sessionCount: 7,
        }}
      />,
    );

    expect(html).toContain('code-agent');
    expect(html).toContain('Alma 对标项目');
    expect(html).toContain('进行中');
    expect(html).toContain('目标');
    expect(html).toContain('补齐会话组织');
    expect(html).toContain('已启动');
    expect(html).toContain('aria-label="从目标 补齐会话组织 新建项目会话"');
    expect(html).toContain('收口 Review Queue');
    expect(html).toContain('清理旧入口');
    expect(html).toContain('已达成');
    expect(html).toContain('已终止');
    expect(html).toContain('产物');
    expect(html).toContain('研究文档');
    expect(html).toContain('aria-label="打开产物 研究文档 的来源会话"');
    expect(html).toContain('文档 · Alma 研究');
    expect(html).toContain('验收报告');
    expect(html).toContain('表格 · QA 会话');
    expect(html).toContain('上下文');
    expect(html).toContain('2 角色 · 7 会话');
    expect(html).toContain('researcher');
    expect(html).toContain('reviewer');
  });

  it('shows a loading label before project metadata arrives', () => {
    const html = renderToStaticMarkup(
      <SidebarProjectDetail fallbackSessionCount={3} />,
    );

    expect(html).toContain('项目详情加载中');
    expect(html).toContain('3 会话');
  });
});

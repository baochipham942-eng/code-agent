// ============================================================================
// ProjectCollaborationDetailPane 时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1）：
// topic 详情「更新于」行的裸 toLocaleString 改走 formatTime(ts, lang) →
// utils/formatDateTime，lang 由 useI18n 注入；zh 24 小时制带年份、绝不跟机器
// locale 出 AM/PM；en 维持 en-US 原样。messagesByConversation 注入空表绕开 IPC
//（ADR-035 的 fixture 注入口）。
// ============================================================================
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({ t: i18nState.language === 'zh' ? zh : en, language: i18nState.language }),
  };
});

import { ProjectCollaborationDetailPane } from '../../../src/renderer/components/features/projectCollaboration/ProjectCollaborationDetailPane';
import type { NeoWorkCardDetail } from '../../../src/shared/contract/tag';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const UPDATED_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05

const DETAIL: NeoWorkCardDetail = {
  workCard: {
    id: 'card-1',
    projectId: 'proj-1',
    sourceConversationId: 'conv-1',
    sourceTurnId: 'turn-1',
    requesterUserId: 'local-user',
    title: '搭一个落地页',
    status: 'completed',
    currentRevisionId: 'rev-1',
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
  },
  currentRevision: null,
  approvedRevision: null,
  revisions: [],
  approvals: [],
  deltas: [],
  resultReviews: [],
  memoryCandidates: [],
};

function renderPane(): string {
  return renderToStaticMarkup(
    <ProjectCollaborationDetailPane detail={DETAIL} messagesByConversation={{}} />,
  );
}

describe('ProjectCollaborationDetailPane 时间口径（跟随 UI language）', () => {
  it('zh UI：更新于 24 小时制带年份，无 AM/PM', () => {
    i18nState.language = 'zh';
    const html = renderPane();
    expect(html).toContain('更新于');
    expect(html).toContain('2026/11/09 16:05');
    expect(html).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', () => {
    i18nState.language = 'en';
    const html = renderPane();
    expect(html).toContain('11/9/2026, 4:05:00 PM');
    expect(html).not.toContain('16:05');
  });
});

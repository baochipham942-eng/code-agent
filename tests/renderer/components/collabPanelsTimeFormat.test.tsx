// @vitest-environment jsdom
// ============================================================================
// 协作两屏时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// ProjectCollaborationPanel TopicRow 与 CloudCollabCardsSection CloudCardRow 的
// 「请求人 + 更新时间」行，裸 toLocaleString 改走 utils/formatDateTime(ts, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// ============================================================================
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CloudCollabCard } from '@shared/contract/project';
import type { NeoWorkCardDetail } from '../../../src/shared/contract/tag';

vi.mock('../../../src/renderer/services/projectClient', () => ({
  listCloudCards: vi.fn(),
  resyncCloudCards: vi.fn(),
}));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: null }) => unknown) => selector({ user: null }),
}));
// ProjectCollaborationPanel 走 renderToStaticMarkup（服务端渲染路径）：zustand 的
// getServerSnapshot 返回初始 state，useAppStore.setState 影响不到静态渲染——
// 改 mock useI18n 定桩 language（同 projectCollaborationDetailPaneTime.test.tsx）。
const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({ t: i18nState.language === 'zh' ? zh : en, language: i18nState.language }),
  };
});

import { listCloudCards } from '../../../src/renderer/services/projectClient';
import { CloudCollabCardsSection } from '../../../src/renderer/components/features/projectSpace/CloudCollabCardsSection';
import { ProjectCollaborationPanel } from '../../../src/renderer/components/features/projectCollaboration/ProjectCollaborationPanel';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const UPDATED_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

const CARD: CloudCollabCard = {
  localCardId: 'card-a',
  sourceUserId: 'user-b',
  title: '竞品调研报告',
  status: 'working',
  priority: 'high',
  dueAt: null,
  updatedAt: UPDATED_AT,
  requesterUserId: 'user-b',
  readonly: true,
};

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

beforeEach(() => {
  vi.mocked(listCloudCards).mockResolvedValue([CARD]);
  i18nState.language = 'zh';
});

afterEach(cleanup);

describe('CloudCollabCardsSection 云卡行更新时间（跟随 UI language）', () => {
  it('zh UI：更新时间为 24 小时制带年份，无 AM/PM', async () => {
    render(<CloudCollabCardsSection projectId="proj-c1" />);
    const row = await screen.findByTestId('cloud-collab-card-card-a');
    await waitFor(() => {
      expect(row.textContent).toContain(ZH);
    });
    expect(row.textContent).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    i18nState.language = 'en';
    render(<CloudCollabCardsSection projectId="proj-c1" />);
    const row = await screen.findByTestId('cloud-collab-card-card-a');
    await waitFor(() => {
      expect(row.textContent).toContain(EN);
    });
    expect(row.textContent).not.toContain('16:05');
  });
});

describe('ProjectCollaborationPanel topic 行更新时间（跟随 UI language）', () => {
  it('zh UI：更新时间为 24 小时制带年份，无 AM/PM', () => {
    i18nState.language = 'zh';
    const html = renderToStaticMarkup(
      <ProjectCollaborationPanel projectId="proj-1" details={[DETAIL]} />,
    );
    expect(html).toContain('搭一个落地页');
    expect(html).toContain(ZH);
    expect(html).not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', () => {
    i18nState.language = 'en';
    const html = renderToStaticMarkup(
      <ProjectCollaborationPanel projectId="proj-1" details={[DETAIL]} />,
    );
    expect(html).toContain(EN);
    expect(html).not.toContain('16:05');
  });
});

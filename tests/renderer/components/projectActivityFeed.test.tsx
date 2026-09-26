// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ProjectActivityFeed } from '../../../src/renderer/components/features/projectSpace/ProjectActivityFeed';

const tagClientMocks = vi.hoisted(() => ({
  // listByProject 返回 detail 列表（组件取 .workCard）
  listByProject: vi.fn(async () => [
    { workCard: { id: 'nwc_done', title: '完成态卡', status: 'in_result_review', updatedAt: 300, sourceConversationId: 'c1' } },
    { workCard: { id: 'nwc_failed', title: '失败态卡', status: 'failed', updatedAt: 100, sourceConversationId: 'c1' } },
  ]),
}));

vi.mock('../../../src/renderer/services/tagClient', () => ({ tagClient: tagClientMocks }));
vi.mock('../../../src/renderer/services/projectClient', () => ({ getProjectArtifacts: async () => [] }));

describe('ProjectActivityFeed topic 状态徽标', () => {
  afterEach(() => cleanup());

  it('渲染用户视角中文相位，不泄漏 in_result_review 等内部枚举（N-OUTCOME-STAMP-USERFACE 口径）', async () => {
    render(
      <ProjectActivityFeed
        projectId="proj_1"
        onOpenSession={() => undefined}
        onOpenTopic={() => undefined}
        onOpenArtifact={() => undefined}
      />,
    );

    await waitFor(() => expect(screen.getByText('完成态卡')).toBeTruthy());
    const html = document.body.innerHTML;
    expect(html).toContain('已完成');
    expect(html).toContain('失败');
    expect(html).not.toContain('in_result_review');
    expect(html).not.toContain('>failed<');
  });
});

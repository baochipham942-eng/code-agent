// ============================================================================
// RoleDetailPage 主动性区（N-ROLE-PROACTIVITY-CHAT-TUNE ④ renderer 半）：
// set_role_proactivity 写入后的 detail 载荷（level=daily + cadence 每日简报 cron +
// topicsExclude 含「天气」）在角色页 records tab 上正确呈现——每日简报选中态、
// 「永远别提」输入与生效行带出天气。经组件公开入口验证，不加 test-only 导出。
// ============================================================================
// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelDetail } from '../../../src/shared/contract/roleAssets';

const invokeDomain = vi.fn();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: () => () => {},
  },
}));

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: () => Promise.resolve([]),
}));

import { RoleDetailPage } from '../../../src/renderer/components/features/expert/RoleDetailPage';

function detailAfterChatTune(): RolePanelDetail {
  return {
    roleId: '研究员',
    definition: '---\nname: 研究员\n---\n你是调研专家',
    definitionPath: '/roles/研究员.md',
    memories: [],
    history: [],
    // set_role_proactivity（once_a_day + add_exclude 天气）写后 resolveRoleProactivityConfig 的返回形状
    proactivity: {
      level: 'daily',
      cadence: '0 0 9 * * *',
      topicsExclude: ['股票', '天气'],
    },
    visual: { displayName: '研究员', profession: '调研专家', icon: 'ClipboardList', category: 'research', tags: [], quickPrompts: [] },
    isBuiltin: false,
    personalization: { userExpectation: '', soul: '', boundaries: { disallowExternalSending: false } },
    equipment: { skills: [], tools: [], model: 'balanced', maxIterations: 20, availableSkills: [], availableTools: [] },
  };
}

function renderRoleDetail(detail: RolePanelDetail) {
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'detail') return Promise.resolve(detail);
    if (action === 'listBoundCronJobs') return Promise.resolve([]);
    if (action === 'listBindings') return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  return render(<RoleDetailPage roleId="研究员" />);
}

describe('RoleDetailPage 主动性区（chat 写入后的载荷呈现）', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('每日简报为选中态（aria-pressed），静默/实时未选中', async () => {
    renderRoleDetail(detailAfterChatTune());
    fireEvent.click(await screen.findByTestId('role-detail-tab-records'));

    const options = await screen.findAllByRole('button', { name: /每日简报|静默|实时介入/ });
    const dailyOption = options.find((button) => button.textContent?.includes('每日简报'));
    const silentOption = options.find((button) => button.textContent?.includes('静默'));
    const realtimeOption = options.find((button) => button.textContent?.includes('实时介入'));
    expect(dailyOption).toBeDefined();
    expect(silentOption).toBeDefined();
    expect(realtimeOption).toBeDefined();
    expect(dailyOption?.getAttribute('aria-pressed')).toBe('true');
    expect(silentOption?.getAttribute('aria-pressed')).toBe('false');
    expect(realtimeOption?.getAttribute('aria-pressed')).toBe('false');
  });

  it('「永远别提」输入框与生效行带出天气（话题合并追加不整换）', async () => {
    renderRoleDetail(detailAfterChatTune());
    fireEvent.click(await screen.findByTestId('role-detail-tab-records'));

    const excludeInput = await screen.findByTestId('role-topics-exclude');
    expect((excludeInput as HTMLInputElement).value).toBe('股票, 天气');
    const active = await screen.findByTestId('role-topics-exclude-active');
    expect(active.textContent).toContain('天气');
    expect(active.textContent).toContain('股票');
  });
});

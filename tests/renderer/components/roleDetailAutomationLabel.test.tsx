// ============================================================================
// RoleDetailPage 绑定自动化频率行（FB-326 返修）：cron 分支走共享
// formatCronExpressionLabel，与「自动化已创建」通知、自动化记录同一文案源。
// 经组件公开入口（records tab 的绑定自动化区）验证，不加 test-only 导出。
// ============================================================================
// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelDetail, RoleBoundCronJob } from '../../../src/shared/contract/roleAssets';

const invokeDomain = vi.fn();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: () => () => {},
  },
}));

// RoleBindingsSection 会把 listLibraryItems 的返回直接 setLibraryItems 后 .map；
// 这里不关心资料架，给个空列表防 undefined 崩渲染。
vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: () => Promise.resolve([]),
}));

import { RoleDetailPage } from '../../../src/renderer/components/features/expert/RoleDetailPage';

function makeRoleDetail(): RolePanelDetail {
  return {
    roleId: '牧之',
    definition: '---\nname: 牧之\n---\n你是产品专家',
    definitionPath: '/roles/牧之.md',
    memories: [],
    history: [],
    proactivity: { level: 'silent' },
    visual: { displayName: '牧之', profession: '资深产品经理', icon: 'ClipboardList', category: 'product', tags: [], quickPrompts: [] },
    isBuiltin: true,
    personalization: { userExpectation: '', soul: '', boundaries: { disallowExternalSending: false } },
    equipment: { skills: [], tools: [], model: 'balanced', maxIterations: 20, availableSkills: [], availableTools: [] },
  };
}

function cronJob(expression: string, timezone?: string): RoleBoundCronJob {
  return {
    id: 'cron-morning',
    name: '晨间提醒',
    schedule: { type: 'cron', expression, timezone },
    enabled: true,
    nextRunAt: 0,
    actionType: 'agent',
  };
}

function renderRoleWithJobs(jobs: RoleBoundCronJob[]) {
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'detail') return Promise.resolve(makeRoleDetail());
    if (action === 'listBoundCronJobs') return Promise.resolve(jobs);
    if (action === 'listBindings') return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  return render(<RoleDetailPage roleId="牧之" />);
}

async function findAutomationRow() {
  fireEvent.click(await screen.findByTestId('role-detail-tab-records'));
  return screen.findByTestId('role-bound-automation-cron-morning');
}

describe('RoleDetailPage 绑定自动化频率行（FB-326）', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('cron 任务显示人话：17 8 * * * · Asia/Shanghai → 每天 08:17，不再裸 cron', async () => {
    renderRoleWithJobs([cronJob('17 8 * * *', 'Asia/Shanghai')]);
    const row = await findAutomationRow();
    expect(row.textContent).toContain('每天 08:17');
    expect(row.textContent).not.toContain('17 8 * * *');
    expect(row.textContent).not.toContain('Cron ·');
  });

  it('复杂表达式走「自定义时间」前缀，与通知/记录同款回退', async () => {
    renderRoleWithJobs([cronJob('0 9 1,15 * *', 'Asia/Shanghai')]);
    const row = await findAutomationRow();
    expect(row.textContent).toContain('自定义时间 · 0 9 1,15 * * · Asia/Shanghai');
  });
});

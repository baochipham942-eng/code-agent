// @vitest-environment jsdom
// C1 云端成员卡只读区聚焦测试：loading/empty/error/列表渲染 + resync 成败反馈 +
// 反向断言——云卡行没有任何编辑动作（无按钮、无 role=button、无取消/归档/审批文案）。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CloudCollabCard } from '@shared/contract/project';
import { projectSpaceZh } from '../../../src/renderer/i18n/projectSpace';

const ps = projectSpaceZh.projectSpace;

vi.mock('../../../src/renderer/services/projectClient', () => ({
  listCloudCards: vi.fn(),
  resyncCloudCards: vi.fn(),
}));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: null }) => unknown) => selector({ user: null }),
}));

import { listCloudCards, resyncCloudCards } from '../../../src/renderer/services/projectClient';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { CloudCollabCardsSection } from '../../../src/renderer/components/features/projectSpace/CloudCollabCardsSection';

const PROJECT_ID = 'proj-c1';

const cardRunning: CloudCollabCard = {
  localCardId: 'card-a',
  sourceUserId: 'user-b',
  title: '竞品调研报告',
  status: 'working',
  priority: 'high',
  dueAt: null,
  updatedAt: 1720000000000,
  requesterUserId: 'user-b',
  readonly: true,
};
const cardDone: CloudCollabCard = {
  localCardId: 'card-b',
  sourceUserId: 'user-c',
  title: '上线检查单',
  status: 'completed',
  priority: 'medium',
  dueAt: 1710000000000,
  updatedAt: 1720000100000,
  requesterUserId: 'user-c',
  readonly: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ language: 'zh' } as never);
  vi.mocked(listCloudCards).mockResolvedValue([cardRunning, cardDone]);
  vi.mocked(resyncCloudCards).mockResolvedValue({ queued: 2, synced: 2, failed: 0 });
});

afterEach(() => {
  cleanup();
});

describe('CloudCollabCardsSection 加载三态', () => {
  it('loading：请求未决时显示加载指示，决出后渲染云卡行', async () => {
    const gate = deferred<CloudCollabCard[]>();
    vi.mocked(listCloudCards).mockReturnValue(gate.promise);
    render(<CloudCollabCardsSection projectId={PROJECT_ID} />);
    expect(screen.getByTestId('cloud-collab-loading').textContent).toContain(ps.cloudCardsLoading);
    gate.resolve([cardRunning]);
    await screen.findByTestId(`cloud-collab-card-${cardRunning.localCardId}`);
    expect(screen.queryByTestId('cloud-collab-loading')).toBeNull();
  });

  it('列表：渲染标题/相位/优先级/只读徽标/计数，requester 与更新时间上屏', async () => {
    render(<CloudCollabCardsSection projectId={PROJECT_ID} />);
    const section = await screen.findByTestId('cloud-collab-cards-section');
    await screen.findByTestId(`cloud-collab-card-${cardRunning.localCardId}`);
    expect(within(section).getByTestId('cloud-collab-readonly-badge').textContent).toBe(ps.cloudCardsReadonlyBadge);
    expect(screen.getByTestId(`cloud-collab-card-${cardRunning.localCardId}`).textContent).toContain('竞品调研报告');
    expect(screen.getByTestId(`cloud-collab-card-${cardRunning.localCardId}`).textContent).toContain('运行中');
    expect(screen.getByTestId(`cloud-collab-priority-${cardRunning.localCardId}`)).toBeTruthy();
    expect(screen.getByTestId(`cloud-collab-card-${cardDone.localCardId}`).textContent).toContain('已完成');
    expect(screen.getByTestId(`cloud-collab-due-${cardDone.localCardId}`).textContent).toContain('截止');
    expect(screen.getByTestId(`cloud-collab-card-${cardDone.localCardId}`).textContent).toContain('user-c');
    // 计数 = 2
    expect(section.textContent).toContain('2');
  });

  it('empty：无云卡时显示空态文案', async () => {
    vi.mocked(listCloudCards).mockResolvedValue([]);
    render(<CloudCollabCardsSection projectId={PROJECT_ID} />);
    const empty = await screen.findByTestId('cloud-collab-empty');
    expect(empty.textContent).toBe(ps.cloudCardsEmpty);
  });

  it('error：展示真因 + 重试按钮；重试成功后渲染列表', async () => {
    vi.mocked(listCloudCards).mockRejectedValueOnce(new Error('协同服务当前不可用'));
    render(<CloudCollabCardsSection projectId={PROJECT_ID} />);
    const error = await screen.findByTestId('cloud-collab-load-error');
    expect(error.textContent).toContain(ps.cloudCardsLoadFailed);
    expect(error.textContent).toContain('协同服务当前不可用');
    fireEvent.click(screen.getByTestId('cloud-collab-retry'));
    await screen.findByTestId(`cloud-collab-card-${cardRunning.localCardId}`);
    expect(listCloudCards).toHaveBeenCalledTimes(2);
  });
});

describe('CloudCollabCardsSection 只读反向断言', () => {
  it('云卡行无任何编辑动作：行内无按钮、无 role=button、无取消/归档/审批入口', async () => {
    render(<CloudCollabCardsSection projectId={PROJECT_ID} />);
    const list = await screen.findByTestId('cloud-collab-list');
    // 列表内（卡片行区域）不允许出现任何按钮/可输入控件
    expect(within(list).queryByRole('button')).toBeNull();
    expect(within(list).queryByRole('textbox')).toBeNull();
    expect(within(list).queryByRole('checkbox')).toBeNull();
    for (const card of [cardRunning, cardDone]) {
      const row = screen.getByTestId(`cloud-collab-card-${card.localCardId}`);
      expect(row.getAttribute('data-readonly')).toBe('true');
      expect(row.getAttribute('role')).toBeNull();
      expect(row.textContent).not.toMatch(/取消|归档|审批|编辑/);
    }
    // 全 section 唯一动作 = resync 按钮（不存在任何卡级动作按钮）
    const buttons = within(await screen.findByTestId('cloud-collab-cards-section')).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute('data-testid')).toBe('cloud-collab-resync');
  });
});

describe('CloudCollabCardsSection resync 反馈', () => {
  it('成功：调 resyncCloudCards 并展示同步计数（成功/失败）', async () => {
    render(<CloudCollabCardsSection projectId={PROJECT_ID} />);
    await screen.findByTestId('cloud-collab-list');
    fireEvent.click(screen.getByTestId('cloud-collab-resync'));
    await waitFor(() => expect(resyncCloudCards).toHaveBeenCalledWith(PROJECT_ID));
    const feedback = await screen.findByTestId('cloud-collab-resync-success');
    expect(feedback.textContent).toBe(ps.cloudCardsResyncSuccess.replace('{synced}', '2').replace('{failed}', '0'));
  });

  it('失败：展示 host 真因，云卡列表不丢', async () => {
    vi.mocked(resyncCloudCards).mockRejectedValue(new Error('请先登录后再使用协同空间。'));
    render(<CloudCollabCardsSection projectId={PROJECT_ID} />);
    await screen.findByTestId('cloud-collab-list');
    fireEvent.click(screen.getByTestId('cloud-collab-resync'));
    const feedback = await screen.findByTestId('cloud-collab-resync-error');
    expect(feedback.textContent).toContain(ps.cloudCardsResyncFailed);
    expect(feedback.textContent).toContain('请先登录后再使用协同空间。');
    expect(screen.getByTestId(`cloud-collab-card-${cardRunning.localCardId}`)).toBeTruthy();
  });

  it('进行中：按钮禁用并显示同步中文案，防重复触发', async () => {
    const gate = deferred<{ queued: number; synced: number; failed: number }>();
    vi.mocked(resyncCloudCards).mockReturnValue(gate.promise);
    render(<CloudCollabCardsSection projectId={PROJECT_ID} />);
    await screen.findByTestId('cloud-collab-list');
    const button = screen.getByTestId('cloud-collab-resync');
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(button.textContent).toBe(ps.cloudCardsResyncing);
    fireEvent.click(button);
    expect(resyncCloudCards).toHaveBeenCalledTimes(1);
    gate.resolve({ queued: 1, synced: 1, failed: 0 });
    await screen.findByTestId('cloud-collab-resync-success');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

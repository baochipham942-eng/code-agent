// ============================================================================
// RoleWakeProposalsCard Tests — ③ 两条卡渲染；accept 走 seed 路径并消失（不碰
// skipFirstWake）；dismiss 移除
// ============================================================================
// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleWakeProposal } from '../../../src/shared/contract/roleAssets';

const listWakeProposals = vi.fn<(roleId: string) => Promise<RoleWakeProposal[]>>();
const acceptWakeProposal = vi.fn<(roleId: string, title: string) => Promise<{ prompt: string } | null>>();
const dismissWakeProposal = vi.fn<(roleId: string, title: string) => Promise<{ success: boolean }>>();
const skipFirstWake = vi.fn();
const goToExpertThread = vi.fn<(roleId: string, options?: { seed?: string }) => Promise<void>>();

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  listWakeProposals: (roleId: string) => listWakeProposals(roleId),
  acceptWakeProposal: (roleId: string, title: string) => acceptWakeProposal(roleId, title),
  dismissWakeProposal: (roleId: string, title: string) => dismissWakeProposal(roleId, title),
  skipFirstWake: (...args: unknown[]) => skipFirstWake(...args),
}));
vi.mock('../../../src/renderer/utils/inviteExpert', () => ({
  goToExpertThread: (...args: unknown[]) => goToExpertThread(...(args as [string, { seed?: string }?])),
}));

import { RoleWakeProposalsCard } from '../../../src/renderer/components/features/chat/RoleWakeProposalsCard';

const PROPOSALS: RoleWakeProposal[] = [
  { title: '改期 14:00 的会', prompt: '拟一封把 14:00 会议改期的邮件草稿', createdAt: '2026-10-26T01:00:00.000Z' },
  { title: '催一下报价', prompt: '起草跟进报价的邮件草稿', createdAt: '2026-10-26T01:00:00.000Z' },
];

describe('RoleWakeProposalsCard', () => {
  beforeEach(() => {
    listWakeProposals.mockReset();
    acceptWakeProposal.mockReset();
    dismissWakeProposal.mockReset();
    skipFirstWake.mockReset();
    goToExpertThread.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it('两条提议各渲染成卡（标题按钮 + 先不按钮）', async () => {
    listWakeProposals.mockResolvedValue(PROPOSALS);
    render(<RoleWakeProposalsCard roleId="role-1" />);
    await waitFor(() => { expect(screen.getByTestId('role-wake-proposals-card')).toBeTruthy(); });
    expect(screen.getByText('改期 14:00 的会')).toBeTruthy();
    expect(screen.getByText('催一下报价')).toBeTruthy();
    expect(screen.getAllByText('先不')).toHaveLength(2);
  });

  it('无提议 / 拉取失败：不渲染', async () => {
    listWakeProposals.mockResolvedValue([]);
    const { container } = render(<RoleWakeProposalsCard roleId="role-1" />);
    await waitFor(() => { expect(listWakeProposals).toHaveBeenCalled(); });
    expect(container.querySelector('[data-testid="role-wake-proposals-card"]')).toBeNull();
  });

  it('accept：以返回的 prompt 走 goToExpertThread seed 路径，卡片消失，不调 skipFirstWake', async () => {
    listWakeProposals.mockResolvedValue(PROPOSALS);
    acceptWakeProposal.mockResolvedValue({ prompt: '拟一封把 14:00 会议改期的邮件草稿' });
    render(<RoleWakeProposalsCard roleId="role-1" />);
    await waitFor(() => { expect(screen.getByText('改期 14:00 的会')).toBeTruthy(); });
    fireEvent.click(screen.getByText('改期 14:00 的会'));
    await waitFor(() => { expect(goToExpertThread).toHaveBeenCalledWith('role-1', { seed: '拟一封把 14:00 会议改期的邮件草稿' }); });
    await waitFor(() => { expect(screen.queryByText('改期 14:00 的会')).toBeNull(); });
    expect(skipFirstWake).not.toHaveBeenCalled();
    // 另一张卡还在（只移除被点的那张）
    expect(screen.getByText('催一下报价')).toBeTruthy();
  });

  it('accept 返回 null（已不在 pending）：本地移除，不走路由', async () => {
    listWakeProposals.mockResolvedValue([PROPOSALS[0]]);
    acceptWakeProposal.mockResolvedValue(null);
    render(<RoleWakeProposalsCard roleId="role-1" />);
    await waitFor(() => { expect(screen.getByText('改期 14:00 的会')).toBeTruthy(); });
    fireEvent.click(screen.getByText('改期 14:00 的会'));
    await waitFor(() => { expect(screen.queryByText('改期 14:00 的会')).toBeNull(); });
    expect(goToExpertThread).not.toHaveBeenCalled();
  });

  it('dismiss：调 dismissWakeProposal 并移除该卡', async () => {
    listWakeProposals.mockResolvedValue(PROPOSALS);
    dismissWakeProposal.mockResolvedValue({ success: true });
    render(<RoleWakeProposalsCard roleId="role-1" />);
    await waitFor(() => { expect(screen.getByText('催一下报价')).toBeTruthy(); });
    fireEvent.click(screen.getAllByText('先不')[1]);
    await waitFor(() => { expect(dismissWakeProposal).toHaveBeenCalledWith('role-1', '催一下报价'); });
    await waitFor(() => { expect(screen.queryByText('催一下报价')).toBeNull(); });
    expect(screen.getByText('改期 14:00 的会')).toBeTruthy();
  });
});

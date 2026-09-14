// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Message, PlanApprovalRecord, PlanApprovalResponse } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({ invokeDomain: vi.fn() }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: mocks.invokeDomain },
}));

import {
  PlanApprovalCard,
  PlanApprovalEvidence,
} from '../../../src/renderer/components/PlanApprovalCard';
import { findPendingPlanApproval, getPlanApprovalRecord } from '../../../src/renderer/utils/planApprovalView';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const approval: PlanApprovalRecord = {
  status: 'pending',
  originalPlan: '1. Read code\n2. Build card\n3. Run tests',
  steps: [
    { id: 'step-1', content: 'Read code', originalContent: 'Read code' },
    { id: 'step-2', content: 'Build card', originalContent: 'Build card' },
    { id: 'step-3', content: 'Run tests', originalContent: 'Run tests' },
  ],
};

const message: Message = {
  id: 'message-plan',
  role: 'assistant',
  content: '',
  timestamp: 1,
  toolCalls: [{
    id: 'tool-plan',
    name: 'exit_plan_mode',
    arguments: {},
    result: {
      toolCallId: 'tool-plan',
      success: true,
      metadata: { planApproval: approval },
    },
  }],
};

const target = {
  sessionId: 'session-1',
  messageId: 'message-plan',
  toolCallId: 'tool-plan',
  approval,
};

function renderCard() {
  return render(<PlanApprovalCard target={target} />);
}

describe('PlanApprovalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      currentSessionId: 'session-1',
      messages: [message],
      sessionTasks: [],
    });
  });

  afterEach(() => cleanup());

  it('edits inline and keeps approval disabled until the edit is saved', () => {
    renderCard();
    const card = screen.getByTestId('plan-approval-card').firstElementChild;
    expect(card?.className).toContain('shadow-md');
    expect(card?.className).toContain('dark:shadow-2xl');
    fireEvent.click(screen.getAllByTitle('编辑')[1]);
    const approveButton = screen.getByTestId('plan-approve-button') as HTMLButtonElement;
    expect(approveButton.disabled).toBe(true);

    const input = screen.getByLabelText('编辑');
    fireEvent.change(input, { target: { value: 'Build editable plan card' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(screen.getByText('Build editable plan card')).toBeTruthy();
    expect(screen.getByText('已改')).toBeTruthy();
    expect(approveButton.disabled).toBe(false);
  });

  it('deletes a step and reorders the remaining rows with native drag events', () => {
    renderCard();
    fireEvent.click(screen.getAllByTitle('删除')[1]);
    expect(screen.queryByText('Build card')).toBeNull();

    const first = screen.getByTestId('plan-step-0');
    const second = screen.getByTestId('plan-step-1');
    fireEvent.dragStart(first);
    fireEvent.dragOver(second);
    fireEvent.drop(second);

    const rows = within(screen.getByTestId('plan-step-list')).getAllByTestId(/plan-step-/);
    expect(rows[0].textContent).toContain('Run tests');
    expect(rows[1].textContent).toContain('Read code');
  });

  it('sends the edited order once and folds the persisted approval locally', async () => {
    const approved: PlanApprovalRecord = {
      ...approval,
      status: 'approved',
      steps: [
        { id: 'step-2', content: 'Build card', originalContent: 'Build card' },
        { id: 'step-1', content: 'Read code', originalContent: 'Read code' },
        { id: 'step-3', content: 'Run tests', originalContent: 'Run tests' },
      ],
      decidedAt: 10,
    };
    const response: PlanApprovalResponse = { approval: approved, tasks: [] };
    mocks.invokeDomain.mockResolvedValue(response);
    renderCard();

    fireEvent.dragStart(screen.getByTestId('plan-step-1'));
    fireEvent.drop(screen.getByTestId('plan-step-0'));
    fireEvent.click(screen.getByTestId('plan-approve-button'));

    await waitFor(() => expect(mocks.invokeDomain).toHaveBeenCalledOnce());
    expect(mocks.invokeDomain).toHaveBeenCalledWith(
      'domain:planning',
      'respondApproval',
      expect.objectContaining({
        decision: 'approve',
        steps: expect.arrayContaining([expect.objectContaining({ content: 'Build card' })]),
      }),
    );
    const updated = useSessionStore.getState().messages[0].toolCalls?.[0].result?.metadata?.planApproval as PlanApprovalRecord;
    expect(updated.status).toBe('approved');
  });

  it('shows the feedback replanning state without emitting a step-edit message', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: '有别的想法…' }));
    expect(screen.getByTestId('plan-feedback-editor')).toBeTruthy();
    expect(mocks.invokeDomain).not.toHaveBeenCalled();
  });

  it('Enter 只执行当前聚焦的主按钮，卡容器聚焦时不直批', async () => {
    renderCard();
    const approve = screen.getByTestId('plan-approve-button');
    expect(document.activeElement).toBe(approve);

    const cardContainer = screen.getByTestId('plan-approval-card').firstElementChild as HTMLElement;
    cardContainer.focus();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(mocks.invokeDomain).not.toHaveBeenCalled();

    approve.focus();
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(mocks.invokeDomain).toHaveBeenCalledOnce());
  });

  it('Esc 保留退编辑、退反馈两级，最后一级收起且不发 cancel', () => {
    renderCard();
    fireEvent.click(screen.getAllByTitle('编辑')[0]);
    expect(document.activeElement).toBe(screen.getByLabelText('编辑'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('编辑')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '有别的想法…' }));
    expect(document.activeElement).toBe(screen.getByPlaceholderText('例如：先做最小闭环，把迁移和兼容放到下一期'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('plan-step-list')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('plan-approval-collapsed')).toBeTruthy();
    expect(mocks.invokeDomain).not.toHaveBeenCalled();
  });

  it('findPendingPlanApproval 认 failed 为可决定卡：启动失败后卡片重现可重试', () => {
    const failedMessage: Message = {
      ...message,
      toolCalls: [{
        ...message.toolCalls![0],
        result: {
          ...message.toolCalls![0].result!,
          metadata: {
            planApproval: { ...approval, status: 'failed', failureReason: 'No active session', decidedAt: 10 },
          },
        },
      }],
    };
    const target = findPendingPlanApproval([failedMessage], 'session-1');
    expect(target?.approval.status).toBe('failed');
    expect(target?.approval.failureReason).toBe('No active session');
    // starting / approved 不再出交互卡。
    const startingTarget = findPendingPlanApproval([{
      ...message,
      toolCalls: [{
        ...message.toolCalls![0],
        result: { ...message.toolCalls![0].result!, metadata: { planApproval: { ...approval, status: 'starting' } } },
      }],
    }], 'session-1');
    expect(startingTarget).toBeNull();
  });

  it('getPlanApprovalRecord 接受新状态（starting/failed）不丢卡', () => {
    for (const status of ['starting', 'failed'] as const) {
      const record = getPlanApprovalRecord({
        ...message.toolCalls![0],
        result: { ...message.toolCalls![0].result!, metadata: { planApproval: { ...approval, status } } },
      });
      expect(record?.status).toBe(status);
    }
  });

  it('失败后卡片带着原因重现且可再批准（同一记录重试）', () => {
    const failed: PlanApprovalRecord = { ...approval, status: 'failed', failureReason: 'Session s1 is already running', decidedAt: 10 };
    render(<PlanApprovalCard target={{ ...target, approval: failed }} />);
    const banner = screen.getByTestId('plan-approval-failure');
    expect(banner.textContent).toContain('Session s1 is already running');
    // 按钮仍然在：失败卡可再次批准/取消。
    expect(screen.getByTestId('plan-approve-button')).toBeTruthy();
    expect(screen.getByText('计划 · 拒绝')).toBeTruthy();
  });

  it('存证行区分 starting 与 failed 摘要', () => {
    render(<PlanApprovalEvidence approval={{ ...approval, status: 'starting', decidedAt: 10 }} />);
    expect(screen.getByText('计划 · 启动中')).toBeTruthy();
    cleanup();
    render(<PlanApprovalEvidence approval={{ ...approval, status: 'failed', failureReason: 'No active session', decidedAt: 10 }} />);
    expect(screen.getByText('计划 · 启动失败')).toBeTruthy();
  });

  it('renders approved evidence as a success-green collapsed row with edited marks', () => {
    render(<PlanApprovalEvidence approval={{
      ...approval,
      status: 'approved',
      steps: [{ id: 'step-1', content: 'Read host code', originalContent: 'Read code', edited: true }],
    }} />);
    const row = screen.getByRole('button', { name: /已允许/ });
    expect(row.className).toContain('text-badge-success');
    expect(screen.queryByText('Read host code')).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText('Read host code')).toBeTruthy();
    expect(screen.getByText('已改')).toBeTruthy();
  });
});

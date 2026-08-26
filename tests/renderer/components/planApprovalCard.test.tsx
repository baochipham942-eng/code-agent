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

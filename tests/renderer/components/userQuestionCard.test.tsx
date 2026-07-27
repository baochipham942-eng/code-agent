// @vitest-environment jsdom
//
// UserQuestionCard（G2 打断式选项卡）行为门：
// - 未作答时提交禁用；单选/多选/「其他」自由文本的回答回传形状与旧 Modal 一致；
// - 跳过（按钮 / Esc）回传 declined，可附原因；
// - 回答/跳过成功后从 pending 队列清除（composer 恢复）；IPC 失败不清除（可重试）。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { UserQuestionRequest } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: invokeMock },
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

import { UserQuestionCard } from '../../../src/renderer/components/UserQuestionCard';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

function makeRequest(overrides: Partial<UserQuestionRequest> = {}): UserQuestionRequest {
  return {
    id: 'q-1',
    sessionId: 's1',
    questions: [
      {
        question: '选哪个方案？',
        header: '方案',
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
      },
    ],
    timestamp: Date.now(),
    ...overrides,
  };
}

function pendingOf(sessionId: string) {
  return useSessionStore.getState().getPendingUserQuestions(sessionId);
}

describe('UserQuestionCard（G2 打断式选项卡）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    useSessionStore.getState().clearPendingUserQuestionsForSession('s1');
  });

  it('未作答时提交禁用，选择后可提交', async () => {
    const request = makeRequest();
    useSessionStore.getState().addPendingUserQuestion(request);
    render(<UserQuestionCard request={request} />);

    const submit = screen.getByRole('button', { name: zh.userQuestion.submit });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText('A'));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        answers: { 方案: 'A' },
      });
    });
    // 回答成功后卡片出队（composer 恢复）
    await waitFor(() => expect(pendingOf('s1')).toHaveLength(0));
  });

  it('单选「其他」自由文本 → 回传输入内容而非固定选项', async () => {
    useSessionStore.getState().addPendingUserQuestion(makeRequest());
    render(<UserQuestionCard request={makeRequest()} />);

    fireEvent.click(screen.getByText(zh.userQuestion.other));
    fireEvent.change(screen.getByPlaceholderText(zh.userQuestion.otherPlaceholder), {
      target: { value: '都不选，改成 C 方案' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.submit }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        answers: { 方案: '都不选，改成 C 方案' },
      });
    });
  });

  it('多选：预设选项 + 「其他」自由文本 → 数组同时包含两者', async () => {
    const request = makeRequest({
      questions: [
        {
          question: '需要哪些能力？',
          header: '能力',
          multiSelect: true,
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
      ],
    });
    useSessionStore.getState().addPendingUserQuestion(request);
    render(<UserQuestionCard request={request} />);

    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText(zh.userQuestion.other));
    fireEvent.change(screen.getByPlaceholderText(zh.userQuestion.otherPlaceholder), {
      target: { value: '还需要导出功能' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.submit }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        answers: { 能力: ['A', '还需要导出功能'] },
      });
    });
  });

  it('跳过按钮：无原因 → declined 不携带 reason，卡片出队', async () => {
    const request = makeRequest();
    useSessionStore.getState().addPendingUserQuestion(request);
    render(<UserQuestionCard request={request} />);

    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.skip }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        declined: true,
      });
    });
    await waitFor(() => expect(pendingOf('s1')).toHaveLength(0));
  });

  it('跳过并填写原因 → declined 响应附带 reason', async () => {
    useSessionStore.getState().addPendingUserQuestion(makeRequest());
    render(<UserQuestionCard request={makeRequest()} />);

    fireEvent.change(screen.getByPlaceholderText(zh.userQuestion.declineReasonPlaceholder), {
      target: { value: '先去处理别的事' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.skip }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        declined: true,
        reason: '先去处理别的事',
      });
    });
  });

  it('Esc = 显式跳过（与权限卡 Esc=拒绝 同族）', async () => {
    useSessionStore.getState().addPendingUserQuestion(makeRequest());
    render(<UserQuestionCard request={makeRequest()} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        declined: true,
      });
    });
  });

  it('IPC 失败不清队列（卡片留在原地可重试）', async () => {
    invokeMock.mockRejectedValue(new Error('ipc down'));
    const request = makeRequest();
    useSessionStore.getState().addPendingUserQuestion(request);
    render(<UserQuestionCard request={request} />);

    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.submit }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    // 给清除动作一个（不应发生的）机会
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pendingOf('s1')).toHaveLength(1);
  });
});

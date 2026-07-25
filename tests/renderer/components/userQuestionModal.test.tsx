// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { UserQuestionRequest } from '../../../src/shared/contract';
import { UserQuestionModal } from '../../../src/renderer/components/UserQuestionModal';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: invokeMock },
}));

function makeRequest(overrides: Partial<UserQuestionRequest> = {}): UserQuestionRequest {
  return {
    id: 'q-1',
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

describe('UserQuestionModal', () => {
  beforeEach(() => {
    useAppStore.setState({ language: 'en' });
    invokeMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('单选题：选中"其他"并输入自由文本 → 提交时回传输入内容而非固定选项', async () => {
    render(<UserQuestionModal request={makeRequest()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Other'));
    const input = screen.getByPlaceholderText('Type your answer…');
    fireEvent.change(input, { target: { value: '都不选，改成 C 方案' } });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        answers: { 方案: '都不选，改成 C 方案' },
      });
    });
  });

  it('多选题：勾选一个预设选项 + "其他"自由文本 → 提交时数组同时包含两者', async () => {
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
    render(<UserQuestionModal request={request} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('Other'));
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), {
      target: { value: '还需要导出功能' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        answers: { 能力: ['A', '还需要导出功能'] },
      });
    });
  });

  it('取消并填写原因 → declined 响应附带 reason', async () => {
    render(<UserQuestionModal request={makeRequest()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Let the agent know why you’re not answering right now'), {
      target: { value: '先去处理别的事' },
    });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        declined: true,
        reason: '先去处理别的事',
      });
    });
  });

  it('取消且不填原因 → declined 响应不携带 reason 字段', async () => {
    render(<UserQuestionModal request={makeRequest()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        declined: true,
      });
    });
  });
});

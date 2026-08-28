// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  currentSessionId: 'feedback-why-session-0',
  sessionIndex: 0,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: mocks.invoke },
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string }) => unknown) => selector({
    currentSessionId: mocks.currentSessionId,
  }),
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      turnFeedback: { helpful: '有帮助', problem: '有问题' },
      turnFeedbackWhy: {
        placeholder: '哪里不对？一句话就行',
        send: '发送',
        skip: '跳过',
        received: '已收到',
        includeAnswer: '附上这段回答（会一起上传）',
        uploadNotice: '这段话会随反馈上传给团队。',
      },
    },
  }),
}));

import { TurnFeedback } from '../../../src/renderer/components/features/chat/TurnFeedback';

function feedbackCalls() {
  return mocks.invoke.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.TELEMETRY_SUBMIT_FEEDBACK);
}

async function renderFeedback() {
  render(<TurnFeedback messageId="message-1" content="完整助手回答" />);
  await waitFor(() => {
    expect(mocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.TELEMETRY_GET_SESSION_FEEDBACK,
      mocks.currentSessionId,
    );
  });
  mocks.invoke.mockClear();
}

describe('TurnFeedback 点踩追问', () => {
  beforeEach(() => {
    mocks.sessionIndex += 1;
    mocks.currentSessionId = `feedback-why-session-${mocks.sessionIndex}`;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(async (channel: string) => (
      channel === IPC_CHANNELS.TELEMETRY_GET_SESSION_FEEDBACK ? [] : { success: true }
    ));
  });

  afterEach(() => cleanup());

  it('T1: 点踩先即时提交纯评分，成功后才展开输入', async () => {
    await renderFeedback();

    fireEvent.click(screen.getByRole('button', { name: '有问题' }));

    expect(await screen.findByTestId('turn-feedback-why')).toBeTruthy();
    expect(feedbackCalls()).toHaveLength(1);
    const payload = feedbackCalls()[0][1];
    expect(payload).toMatchObject({
      sessionId: mocks.currentSessionId,
      turnId: 'message-1',
      messageId: 'message-1',
      rating: -1,
    });
    expect(payload).not.toHaveProperty('comment');
    expect(payload).not.toHaveProperty('fullContent');
  });

  it('T2: 回车二次提交同一锚点与 comment', async () => {
    await renderFeedback();
    fireEvent.click(screen.getByRole('button', { name: '有问题' }));
    const input = await screen.findByRole('textbox', { name: '哪里不对？一句话就行' });

    fireEvent.change(input, { target: { value: '工具选错了' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(feedbackCalls()).toHaveLength(2));
    expect(feedbackCalls()[1][1]).toMatchObject({
      sessionId: mocks.currentSessionId,
      turnId: 'message-1',
      messageId: 'message-1',
      rating: -1,
      comment: '工具选错了',
    });
    expect((await screen.findByTestId('turn-feedback-received')).textContent).toBe('已收到');
  });

  it('T3: 只有显式勾选时二次提交才附上回答正文', async () => {
    await renderFeedback();
    fireEvent.click(screen.getByRole('button', { name: '有问题' }));
    let input = await screen.findByRole('textbox', { name: '哪里不对？一句话就行' });

    fireEvent.change(input, { target: { value: '未勾选' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(feedbackCalls()).toHaveLength(2));
    expect(feedbackCalls()[1][1]).not.toHaveProperty('fullContent');

    fireEvent.click(screen.getByRole('button', { name: '有问题' }));
    input = await screen.findByRole('textbox', { name: '哪里不对？一句话就行' });
    fireEvent.change(input, { target: { value: '已勾选' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '附上这段回答（会一起上传）' }));
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(feedbackCalls()).toHaveLength(3));
    expect(feedbackCalls()[2][1]).toMatchObject({
      comment: '已勾选',
      fullContent: { messageId: 'message-1', assistantResponse: '完整助手回答' },
    });
  });

  it('T4: 点赞只提交一次评分且不展开输入', async () => {
    await renderFeedback();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '有帮助' }));
    });

    await waitFor(() => expect(feedbackCalls()).toHaveLength(1));
    expect(feedbackCalls()[0][1]).toMatchObject({ rating: 1, messageId: 'message-1' });
    expect(screen.queryByTestId('turn-feedback-why')).toBeNull();
  });
  // 2026-08-29 监工补刀：Grok 变异席抓到「跳过」路径零断言——把跳过改成再发一次无 comment 的
  // submit 时 8/8 仍绿。不变量：点踩之后除「发送」外不许再发第二次 TELEMETRY_SUBMIT_FEEDBACK，
  // 否则 host 的 (session,message) upsert 会把已落库的 comment/full_content 洗成 NULL。
  it('T6: 「跳过」只收起输入，不发第二次提交', async () => {
    await renderFeedback();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '有问题' }));
    });
    await waitFor(() => expect(feedbackCalls()).toHaveLength(1));
    fireEvent.change(screen.getByPlaceholderText('哪里不对？一句话就行'), { target: { value: '草稿' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    });

    expect(screen.queryByTestId('turn-feedback-why')).toBeNull();
    expect(feedbackCalls()).toHaveLength(1);
  });

  it('T7: 已点踩后再点「有问题」只重新展开输入，不重复提交评分', async () => {
    await renderFeedback();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '有问题' }));
    });
    await waitFor(() => expect(feedbackCalls()).toHaveLength(1));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    });
    expect(screen.queryByTestId('turn-feedback-why')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '有问题' }));
    });

    expect(screen.getByTestId('turn-feedback-why')).toBeTruthy();
    expect(feedbackCalls()).toHaveLength(1);
  });
});

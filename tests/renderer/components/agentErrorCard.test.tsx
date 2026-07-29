// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentErrorMetadata } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  writeText: vi.fn(),
  dispatchEvent: vi.spyOn(window, 'dispatchEvent'),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

import { AgentErrorCard, buildAgentErrorReport, resolveAgentErrorCopy } from '../../../src/renderer/components/features/chat/AgentErrorCard';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { OPEN_MODEL_SWITCHER_EVENT } from '../../../src/renderer/components/StatusBar/ModelSwitcher';

function makeError(overrides: Partial<AgentErrorMetadata> = {}): AgentErrorMetadata {
  return {
    category: 'model_not_found',
    code: 'RUN_FAILED',
    httpStatus: 404,
    rawMessage: 'AI_APICallError: Not Found',
    modelId: 'my-custom-model',
    timestamp: 1_720_000_000_000,
    ...overrides,
  };
}

function renderCard(error: AgentErrorMetadata, messageId = 'assistant-1', sessionId = 'session-1') {
  return render(<AgentErrorCard error={error} messageId={messageId} sessionId={sessionId} />);
}

describe('AgentErrorCard', () => {
  beforeEach(() => {
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    mocks.writeText.mockReset().mockResolvedValue(undefined);
    mocks.dispatchEvent.mockClear();
    Object.assign(navigator, { clipboard: { writeText: mocks.writeText } });
    useSessionStore.setState({ runningSessionIds: new Set() });
  });

  afterEach(() => {
    cleanup();
    useMessageActionStore.getState().unregister();
  });

  it('renders title, suggestion and detail line from category + metadata', () => {
    renderCard(makeError());

    expect(screen.getByText('模型接口或模型名称不匹配')).toBeTruthy();
    expect(screen.getByText(/Base URL/)).toBeTruthy();
    expect(screen.getByText(/RUN_FAILED/)).toBeTruthy();
    expect(screen.getByText('HTTP 404')).toBeTruthy();
  });

  it.each(['model_not_found', 'forbidden', 'rate_limited', 'concurrency', 'network'] as const)(
    'shows 切换模型 but not 新开会话 for model-ish category %s',
    (category) => {
      renderCard(makeError({ category, httpStatus: undefined }));

      expect(screen.getByRole('button', { name: /切换模型/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /新开会话/ })).toBeNull();
      expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /复制错误报告/ })).toBeTruthy();
    },
  );

  it.each(['context_length', 'generic'] as const)(
    'shows 新开会话 but not 切换模型 for category %s',
    (category) => {
      renderCard(makeError({ category, httpStatus: undefined }));

      expect(screen.getByRole('button', { name: /新开会话/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /切换模型/ })).toBeNull();
    },
  );

  it('fills context-length suggestion with token counts', () => {
    renderCard(makeError({
      category: 'context_length',
      code: 'CONTEXT_LENGTH_EXCEEDED',
      requestedTokens: 4481000,
      maxTokens: 4000000,
    }));

    expect(screen.getByText(/4481K tokens/)).toBeTruthy();
    expect(screen.getByText(/4000K tokens/)).toBeTruthy();
  });

  it('hides the detail line when no code/httpStatus/traceId present', () => {
    const { container } = renderCard(makeError({ code: undefined, httpStatus: undefined, traceId: undefined }));
    expect(container.querySelector('.font-mono')).toBeNull();
  });

  it('retry re-sends the preceding user message through the registered sender', () => {
    const send = vi.fn();
    useMessageActionStore.getState().register(send, () => [
      { id: 'user-1', role: 'user', content: '帮我写个脚本', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 2 },
    ]);

    renderCard(makeError());
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    expect(send).toHaveBeenCalledWith('帮我写个脚本');
  });

  it('disables retry while the session is running', () => {
    useSessionStore.setState({ runningSessionIds: new Set(['session-1']) });
    renderCard(makeError());

    const retry = screen.getByRole('button', { name: /重试/ }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
  });

  it('switch model asks the ModelSwitcher to open', () => {
    renderCard(makeError());
    fireEvent.click(screen.getByRole('button', { name: /切换模型/ }));

    expect(mocks.dispatchEvent).toHaveBeenCalled();
    const event = mocks.dispatchEvent.mock.calls.map(([e]) => e).find(
      (e) => (e as Event).type === OPEN_MODEL_SWITCHER_EVENT,
    );
    expect(event).toBeTruthy();
  });

  it('new session goes through the session store createSession path', () => {
    const createSession = vi.fn().mockResolvedValue(null);
    useSessionStore.setState({ createSession });
    renderCard(makeError({ category: 'context_length', code: 'CONTEXT_LENGTH_EXCEEDED' }));

    fireEvent.click(screen.getByRole('button', { name: /新开会话/ }));
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('copies a structured error report and toasts on success', async () => {
    renderCard(makeError({ traceId: 'trace-123' }));
    fireEvent.click(screen.getByRole('button', { name: /复制错误报告/ }));

    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(1));
    const report = mocks.writeText.mock.calls[0][0] as string;
    expect(report).toContain('模型接口或模型名称不匹配');
    expect(report).toContain('model_not_found');
    expect(report).toContain('RUN_FAILED');
    expect(report).toContain('404');
    expect(report).toContain('trace-123');
    expect(report).toContain('session-1');
    expect(report).toContain('my-custom-model');
    expect(report).toContain('AI_APICallError: Not Found');
    expect(report).toContain(new Date(1_720_000_000_000).toISOString());
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('toasts an error when clipboard write fails', async () => {
    mocks.writeText.mockRejectedValue(new Error('denied'));
    renderCard(makeError());
    fireEvent.click(screen.getByRole('button', { name: /复制错误报告/ }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
  });
});

describe('resolveAgentErrorCopy / buildAgentErrorReport', () => {
  it('resolves copy per category with zh i18n', () => {
    expect(resolveAgentErrorCopy({ category: 'concurrency' }, zh).title).toBe('模型账号并发已满');
    expect(resolveAgentErrorCopy({ category: 'generic' }, zh).title).toBe('运行失败');
  });

  it('falls back to generic copy for unknown categories', () => {
    expect(
      resolveAgentErrorCopy({ category: 'nope' as AgentErrorMetadata['category'] }, zh).title,
    ).toBe('运行失败');
  });

  it('omits missing fields from the report', () => {
    const error = makeError({ code: undefined, httpStatus: undefined, traceId: undefined, modelId: undefined });
    const { title, suggestion } = resolveAgentErrorCopy(error, zh);
    const report = buildAgentErrorReport({ error, title, suggestion, t: zh });

    expect(report).not.toContain('错误码:');
    expect(report).not.toContain('HTTP');
    expect(report).not.toContain('Trace');
    expect(report).toContain('AI_APICallError: Not Found');
  });
});

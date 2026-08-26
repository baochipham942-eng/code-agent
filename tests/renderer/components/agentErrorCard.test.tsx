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

import {
  AgentErrorPresentation,
  buildAgentErrorReport,
  resolveAgentErrorCopy,
} from '../../../src/renderer/components/features/chat/AgentErrorCard';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
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
  return render(<AgentErrorPresentation error={error} messageId={messageId} sessionId={sessionId} />);
}

describe('AgentErrorCard', () => {
  beforeEach(() => {
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    mocks.writeText.mockReset().mockResolvedValue(undefined);
    mocks.dispatchEvent.mockClear();
    Object.assign(navigator, { clipboard: { writeText: mocks.writeText } });
    useSessionStore.setState({ runningSessionIds: new Set() });
    useAppStore.setState({ developerMode: false });
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

  it('余额不足精确提示充值，只给检查账号设置，不引导重试或切换模型', () => {
    renderCard(makeError({ category: 'insufficient_balance', httpStatus: 402 }));

    expect(screen.getByText('这个账号余额不足')).toBeTruthy();
    expect(screen.getByText('去供应商后台充值后即可继续')).toBeTruthy();
    expect(screen.getByRole('button', { name: '检查账号设置' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /切换模型/ })).toBeNull();
  });

  it.each(['model_not_found', 'forbidden', 'concurrency', 'network'] as const)(
    'shows 切换模型 but not 新开会话 for model-ish category %s',
    (category) => {
      renderCard(makeError({ category, httpStatus: undefined }));

      expect(screen.getByRole('button', { name: /切换模型/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /新开会话/ })).toBeNull();
      expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /复制错误报告/ })).toBeNull();
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

  it('shows localized image-limit guidance and avoids a guaranteed-failing retry', () => {
    renderCard(makeError({
      category: 'image_payload',
      code: 'IMAGE_PAYLOAD_EXCEEDED',
      httpStatus: 413,
    }));

    expect(screen.getByText('图片太多或文件太大，模型无法接收')).toBeTruthy();
    expect(screen.getByText(/分批发送/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
    expect(screen.getByRole('button', { name: /新开会话/ })).toBeTruthy();
  });

  it('hides the detail line when no code/httpStatus/traceId/model present', () => {
    const { container } = renderCard(makeError({
      code: undefined,
      httpStatus: undefined,
      traceId: undefined,
      modelId: undefined,
      provider: undefined,
    }));
    expect(container.querySelector('.font-mono')).toBeNull();
  });

  // 切过模型之后「这轮到底跑的谁」是最先要确认的事，所以它排在详情行第一位。
  // 拍板 2026-08-01「折中方案」：主视图只留「这一轮真跑的是哪个模型」（产品负责人的
  // 原始诉求），provider id / 错误码 / HTTP / Trace ID 这些排障字段收进折叠区，
  // 别跟两个有效按钮抢注意力。
  it('主视图只留模型名，服务商 id 收进技术详情折叠区', () => {
    renderCard(makeError({ provider: 'custom-100xlabs', modelId: 'claude-opus-4-8' }));

    expect(screen.getByText('实际使用 claude-opus-4-8')).toBeTruthy();
    // provider 仍然拿得到，但在折叠区里
    const details = screen.getByText('查看技术详情').closest('details');
    expect(details?.textContent).toContain('custom-100xlabs');
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
    useAppStore.setState({ developerMode: true });
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
    useAppStore.setState({ developerMode: true });
    mocks.writeText.mockRejectedValue(new Error('denied'));
    renderCard(makeError());
    fireEvent.click(screen.getByRole('button', { name: /复制错误报告/ }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
  });

  it('rate_limited renders as one quiet retry line and reuses regenerateMessage', () => {
    const send = vi.fn();
    useMessageActionStore.getState().register(send, () => [
      { id: 'user-1', role: 'user', content: '再试一次', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 2 },
    ]);

    render(
      <AgentErrorPresentation
        error={makeError({ category: 'rate_limited', code: 'RATE_LIMITED', httpStatus: 429 })}
        messageId="assistant-1"
        sessionId="session-1"
      />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('rate-limited-error-line').className).toContain('text-xs');
    expect(screen.getByText('模型服务商限流，稍后重试')).toBeTruthy();
    expect(screen.queryByText(/实际使用/)).toBeNull();
    expect(screen.queryByText(/查看技术详情/)).toBeNull();
    expect(screen.queryByText(/切换模型/)).toBeNull();
    expect(screen.queryByText(/复制错误报告/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(send).toHaveBeenCalledWith('再试一次');
  });

  it('rate_limited exposes diagnostics and report only in developer mode', () => {
    useAppStore.setState({ developerMode: true });
    render(
      <AgentErrorPresentation
        error={makeError({
          category: 'rate_limited',
          provider: 'deepseek',
          code: 'RATE_LIMITED',
          httpStatus: 429,
          traceId: 'trace-rate-limit',
        })}
        messageId="assistant-1"
        sessionId="session-1"
      />,
    );

    expect(screen.getByText('查看技术详情')).toBeTruthy();
    expect(screen.getByText('错误码 RATE_LIMITED')).toBeTruthy();
    expect(screen.getByText('HTTP 429')).toBeTruthy();
    expect(screen.getByText('Trace ID trace-rate-limit')).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制错误报告' })).toBeTruthy();
  });

  it('auth keeps the card but hides copy report outside developer mode', () => {
    renderCard(makeError({ category: 'auth', httpStatus: 401 }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '复制错误报告' })).toBeNull();

    cleanup();
    useAppStore.setState({ developerMode: true });
    renderCard(makeError({ category: 'auth', httpStatus: 401 }));
    expect(screen.getByRole('button', { name: '复制错误报告' })).toBeTruthy();
  });
});

describe('resolveAgentErrorCopy / buildAgentErrorReport', () => {
  it('resolves copy per category with zh i18n', () => {
    expect(resolveAgentErrorCopy({ category: 'concurrency' }, zh).title).toBe('模型账号并发已满');
    expect(resolveAgentErrorCopy({ category: 'generic' }, zh).title).toBe('运行失败');
  });

  it('resolves image-limit copy in both languages', () => {
    expect(resolveAgentErrorCopy({ category: 'image_payload' }, zh)).toEqual({
      title: '图片太多或文件太大，模型无法接收',
      suggestion: '请新开会话，只带这次需要的图片；图片较多时分批发送，单张过大时先压缩后再发。',
    });
    expect(resolveAgentErrorCopy({ category: 'image_payload' }, en)).toEqual({
      title: 'There are too many images or the image files are too large',
      suggestion: 'Start a new session with only the images needed for this request. Send large sets in smaller batches, and compress oversized images before sending them.',
    });
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

  // 额度用尽 / 密钥无效：重试一万次都是同一个 401，按钮不该出现
  it('auth 档不给重试，只给换模型', () => {
    renderCard(makeError({ category: 'auth' }));

    expect(screen.queryByText('重试')).toBeNull();
    expect(screen.getByText('切换模型')).toBeTruthy();
  });
});

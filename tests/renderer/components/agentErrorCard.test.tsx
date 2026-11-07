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
    useAppStore.setState({ developerMode: true });
    renderCard(makeError());

    expect(screen.getByText('模型接口或模型名称不匹配')).toBeTruthy();
    expect(screen.getByText(/Base URL/)).toBeTruthy();
    expect(screen.getByText(/RUN_FAILED/)).toBeTruthy();
    expect(screen.getByText('HTTP 404')).toBeTruthy();
  });

  it('余额不足精确提示充值，只给检查账号，不引导重试或换个模型', () => {
    renderCard(makeError({ category: 'insufficient_balance', httpStatus: 402 }));

    expect(screen.getByText('这个账号余额不足')).toBeTruthy();
    expect(screen.getByText('去供应商后台充值后即可继续')).toBeTruthy();
    expect(screen.getByRole('button', { name: '检查账号' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /换个模型/ })).toBeNull();
  });

  it.each(['model_not_found', 'forbidden', 'concurrency', 'network'] as const)(
    'shows 换个模型 but not 新开会话 for model-ish category %s',
    (category) => {
      renderCard(makeError({ category, httpStatus: undefined }));

      expect(screen.getByRole('button', { name: /换个模型/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /新开会话/ })).toBeNull();
      expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /复制错误报告/ })).toBeNull();
    },
  );

  it.each(['context_length', 'generic'] as const)(
    'shows 新开会话 but not 换个模型 for category %s',
    (category) => {
      renderCard(makeError({ category, httpStatus: undefined }));

      expect(screen.getByRole('button', { name: /新开会话/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /换个模型/ })).toBeNull();
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

  it.each([
    { developerMode: false, detailsVisible: false },
    { developerMode: true, detailsVisible: true },
  ])(
    '模型行与技术详情都只对开发者露出（N-UI-AGENT-ERROR-REPEAT-COLLAPSE）：$developerMode',
    ({ developerMode, detailsVisible }) => {
      useAppStore.setState({ developerMode });
      renderCard(makeError({ provider: 'custom-100xlabs', modelId: 'claude-opus-4-8' }));

      const modelLine = screen.queryByText('实际使用 claude-opus-4-8');
      expect(Boolean(modelLine)).toBe(detailsVisible);

      const details = screen.queryByText('查看技术详情')?.closest('details') ?? null;
      expect(Boolean(details)).toBe(detailsVisible);
      if (detailsVisible) {
        // provider 仍然拿得到
        expect(details?.textContent).toContain('custom-100xlabs');
      }
    },
  );

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
    fireEvent.click(screen.getByRole('button', { name: /换个模型/ }));

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
    expect(screen.queryByText(/换个模型/)).toBeNull();
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

  it.each([false, true])(
    'goal-abort provider failure keeps diagnostics off the user card in developerMode=%s',
    (developerMode) => {
      useAppStore.setState({ developerMode });
      renderCard(makeError({
        category: 'generic',
        provider: 'deepseek',
        modelId: 'deepseek-v4-flash',
        rawMessage: 'Too Many Requests',
        goalAbort: true,
      }));

      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.queryByText(/deepseek-v4-flash/)).toBeNull();
      expect(screen.queryByText(/Too Many Requests/)).toBeNull();
      expect(screen.queryByText(/查看技术详情/)).toBeNull();
      expect(screen.queryByRole('button', { name: '复制错误报告' })).toBeNull();
      expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '新开会话' })).toBeTruthy();
    },
  );

  it('auth keeps the card but hides copy report outside developer mode', () => {
    renderCard(makeError({ category: 'auth', httpStatus: 401 }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '复制错误报告' })).toBeNull();

    cleanup();
    useAppStore.setState({ developerMode: true });
    renderCard(makeError({ category: 'auth', httpStatus: 401 }));
    expect(screen.getByRole('button', { name: '复制错误报告' })).toBeTruthy();
  });

  it('interrupted 显示「已中断」和重试，不提供换模型或检查账号，且 en 文案齐全', () => {
    renderCard(makeError({
      category: 'interrupted',
      code: 'RUN_INTERRUPTED',
      httpStatus: undefined,
      rawMessage: 'run interrupted by signal',
    }));

    expect(screen.getByText('已中断')).toBeTruthy();
    expect(screen.getByText('这次运行在给出任何回复之前被停掉了。可以重试。')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /换个模型/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /检查账号/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /新开会话/ })).toBeNull();
    expect(en.agentError.categories.interrupted).toEqual({
      title: 'Interrupted',
      suggestion: 'This run was stopped before any reply. You can retry.',
    });
  });
});

describe('usage_limit card', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
  });

  it('③ 说额度用完 + 本机时区恢复时间，给切换模型、没有重试按钮', () => {
    process.env.TZ = 'Asia/Shanghai';
    renderCard(makeError({ category: 'usage_limit', httpStatus: 429, usageWindowText: '5 小时', resetAt: '2026-11-03T09:34:10.000Z' }));
    expect(screen.getByText('5 小时额度已用完')).toBeTruthy();
    expect(screen.getByText(/预计 11\/3 17:34 恢复/)).toBeTruthy();
    expect(screen.getByRole('button', { name: zh.agentError.actions.switchModel })).toBeTruthy();
    expect(screen.queryByRole('button', { name: zh.agentError.actions.retry })).toBeNull();
    expect(screen.queryByTestId('rate-limited-error-line')).toBeNull();
  });

  it('② 同一时刻在洛杉矶时区显示本地时间；解析不出时间时给「向服务商确认」而不是空白', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(resolveAgentErrorCopy({ category: 'usage_limit', usageWindowText: '5 小时', resetAt: '2026-11-03T09:34:10.000Z' }, zh).suggestion)
      .toContain('11/3 01:34');
    const noTime = resolveAgentErrorCopy({ category: 'usage_limit' }, zh);
    expect(noTime.title).toBe('套餐额度已用完');
    expect(noTime.suggestion).toContain('向服务商确认');
    expect(resolveAgentErrorCopy({ category: 'usage_limit' }, en).suggestion).toContain('ask the provider');
  });

  it('⑤ 普通限流仍渲染灰字行 + 重试', () => {
    renderCard(makeError({ category: 'rate_limited', httpStatus: 429 }));
    expect(screen.getByTestId('rate-limited-error-line')).toBeTruthy();
    expect(screen.getByRole('button', { name: zh.agentError.actions.retry })).toBeTruthy();
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
    expect(screen.getByText('换个模型')).toBeTruthy();
  });
});

// 连续同因失败折叠（N-UI-AGENT-ERROR-REPEAT-COLLAPSE）：run 由投影层从消息列表推导，
// 这里钉住三件事——非最新的压成灰字行、最新整卡带连续次数、rate_limited 不参与折叠。
describe('AgentErrorPresentation 连续同因失败折叠', () => {
  beforeEach(() => {
    useSessionStore.setState({ runningSessionIds: new Set() });
    useAppStore.setState({ developerMode: false });
  });

  afterEach(() => {
    cleanup();
    useMessageActionStore.getState().unregister();
  });

  it('非段内最新：压成一行灰字「没有回复 · 原因」，无按钮、不抢 role=alert', () => {
    render(
      <AgentErrorPresentation
        error={makeError({ category: 'auth', httpStatus: 401 })}
        messageId="assistant-1"
        sessionId="session-1"
        run={{ runLength: 2, latest: false }}
      />,
    );

    const line = screen.getByTestId('agent-error-muted-line');
    expect(line.textContent).toBe('没有回复 · 账号没通过授权');
    expect(line.className).toContain('text-text-tertiary');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('段内最新且 runLength≥2：整卡说明连续次数，不可重试类（auth）明说再发也不会好，中文句间无空格', () => {
    const { container } = render(
      <AgentErrorPresentation
        error={makeError({ category: 'auth', httpStatus: 401 })}
        messageId="assistant-3"
        sessionId="session-1"
        run={{ runLength: 3, latest: true }}
      />,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('连续 3 次都是这个原因，再发也不会好。')).toBeTruthy();
    expect(container.textContent).toContain('密钥可能填错、过期，或者额度用完了。连续 3 次都是这个原因，再发也不会好。');
    expect(container.textContent).not.toContain('。 连续');
    // 动作可见性不因折叠改变：auth 仍是换个模型 + 检查账号、无重试
    expect(screen.getByRole('button', { name: '换个模型' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '检查账号' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
  });

  it('可重试类（network）用中性措辞，只说次数、不断言再发也不会好', () => {
    render(
      <AgentErrorPresentation
        error={makeError({ category: 'network' })}
        messageId="assistant-2"
        sessionId="session-1"
        run={{ runLength: 2, latest: true }}
      />,
    );

    expect(screen.getByText('连续 2 次都是这个原因。')).toBeTruthy();
    expect(screen.queryByText(/再发也不会好/)).toBeNull();
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
  });

  it('runLength 1 或缺 run：不出现连续次数句，维持单次失败整卡', () => {
    const { unmount } = render(
      <AgentErrorPresentation
        error={makeError({ category: 'network' })}
        messageId="assistant-1"
        sessionId="session-1"
        run={{ runLength: 1, latest: true }}
      />,
    );
    expect(screen.queryByText(/连续/)).toBeNull();
    unmount();

    render(
      <AgentErrorPresentation
        error={makeError({ category: 'network' })}
        messageId="assistant-1"
        sessionId="session-1"
      />,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/连续/)).toBeNull();
  });

  it('同一轮内的重复报错（duplicate）整条不渲染', () => {
    const { container } = render(
      <AgentErrorPresentation
        error={makeError({ category: 'auth', httpStatus: 401 })}
        messageId="assistant-1"
        sessionId="session-1"
        run={{ runLength: 1, latest: false, duplicate: true }}
      />,
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('agent-error-muted-line')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rate_limited 不参与折叠：带 latest=false 仍走灰字行 + 重试路径', () => {
    render(
      <AgentErrorPresentation
        error={makeError({ category: 'rate_limited', httpStatus: 429 })}
        messageId="assistant-1"
        sessionId="session-1"
        run={{ runLength: 2, latest: false }}
      />,
    );

    expect(screen.getByTestId('rate-limited-error-line')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByTestId('agent-error-muted-line')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('灰字行与连续次数句的 en 词条齐全', () => {
    expect(en.agentError.mutedLine).toBe('No reply · {reason}');
    expect(en.agentError.repeat.noRetry).toContain('{n}');
    expect(en.agentError.repeat.retryable).not.toContain('resending will not fix');
    expect(en.agentError.shortReasons.auth).toBe('account authorization failed');
    expect(en.agentError.categories.auth.suggestion).toBe('The key may be wrong or expired, or the quota may be used up.');
    expect(en.agentError.actions.switchModel).toBe('Switch model');
    expect(en.agentError.actions.checkAccount).toBe('Check account');
  });

  it('短原因查表行为：未知类回落 generic', () => {
    render(
      <AgentErrorPresentation
        error={makeError({ category: 'nope' as AgentErrorMetadata['category'] })}
        messageId="assistant-1"
        sessionId="session-1"
        run={{ runLength: 2, latest: false }}
      />,
    );
    expect(screen.getByTestId('agent-error-muted-line').textContent).toBe('没有回复 · 运行失败');
  });
});

import { describe, expect, it } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import {
  attachAgentErrorToLatestAssistant,
  endsTheTurn,
  classifyAgentError,
  getAgentErrorMessage,
  isTerminalAgentError,
  normalizeAgentErrorPayload,
} from '../../../src/renderer/hooks/agent/effects/useSessionLifecycleEffects';

describe('agent lifecycle error helpers', () => {
  it('treats nested warning payloads as non-terminal', () => {
    const payload = {
      data: {
        message: '工具连续 2 次失败: Cannot find module docx',
        level: 'warning',
      },
      sessionId: 'session-1',
    };

    expect(normalizeAgentErrorPayload(payload)).toMatchObject({
      message: '工具连续 2 次失败: Cannot find module docx',
      level: 'warning',
      sessionId: 'session-1',
    });
    expect(getAgentErrorMessage(payload)).toBe('工具连续 2 次失败: Cannot find module docx');
    expect(isTerminalAgentError(payload)).toBe(false);
  });

  it('does not invent errors for empty payloads', () => {
    expect(getAgentErrorMessage({})).toBeNull();
    expect(classifyAgentError({})).toBeNull();
  });
});

describe('classifyAgentError 模型归属', () => {
  it('用 host 报的实跑模型，而不是前端当前选中的模型', () => {
    const error = classifyAgentError(
      {
        code: 'RUN_FAILED',
        message: 'Cannot connect to API: Client network socket disconnected',
        details: { provider: 'custom-100xlabs', model: 'claude-opus-4-8' },
      },
      { modelId: 'deepseek-v4-pro' },
    );

    expect(error).toMatchObject({
      category: 'network',
      provider: 'custom-100xlabs',
      modelId: 'claude-opus-4-8',
    });
  });

  it('host 没带模型时才回落到前端当前模型', () => {
    const error = classifyAgentError(
      { code: 'RUN_FAILED', message: 'boom' },
      { modelId: 'deepseek-v4-pro' },
    );

    expect(error?.modelId).toBe('deepseek-v4-pro');
    expect(error?.provider).toBeUndefined();
  });
});

describe('classifyAgentError', () => {
  it('classifies context length errors with token details', () => {
    const error = classifyAgentError({
      code: 'CONTEXT_LENGTH_EXCEEDED',
      message: '上下文超限',
      details: { requested: 4481000, max: 4000000 },
      suggestion: '新开会话继续。',
    });

    expect(isTerminalAgentError({ code: 'CONTEXT_LENGTH_EXCEEDED', message: '上下文超限' })).toBe(true);
    expect(error).toMatchObject({
      category: 'context_length',
      code: 'CONTEXT_LENGTH_EXCEEDED',
      requestedTokens: 4481000,
      maxTokens: 4000000,
      rawMessage: '上下文超限',
    });
    expect(error?.timestamp).toBeGreaterThan(0);
  });

  it('classifies 403 Forbidden as forbidden with http status', () => {
    const error = classifyAgentError({ code: 'RUN_FAILED', message: 'Forbidden' });

    expect(error).toMatchObject({ category: 'forbidden', httpStatus: 403 });
  });

  it('classifies 404 Not Found as model_not_found with http status', () => {
    const error = classifyAgentError({ code: 'RUN_FAILED', message: 'Not Found' });

    expect(error).toMatchObject({ category: 'model_not_found', httpStatus: 404 });
  });

  it('classifies provider concurrency limits', () => {
    const error = classifyAgentError({
      code: 'RUN_FAILED',
      message: 'Concurrency limit exceeded for account, please retry later',
    });

    expect(error?.category).toBe('concurrency');
  });

  it('classifies 429 / rate limit messages as rate_limited', () => {
    expect(classifyAgentError({ code: 'RUN_FAILED', message: 'Rate limit exceeded' })?.category).toBe('rate_limited');
    expect(classifyAgentError({ code: 'RUN_FAILED', message: 'HTTP 429 Too Many Requests' })).toMatchObject({
      category: 'rate_limited',
      httpStatus: 429,
    });
  });

  it('classifies network-style failures as network', () => {
    expect(classifyAgentError({ code: 'RUN_FAILED', message: 'fetch failed' })?.category).toBe('network');
    expect(classifyAgentError({ code: 'RUN_FAILED', message: 'connect ECONNREFUSED 127.0.0.1:443' })?.category).toBe('network');
    expect(classifyAgentError({ code: 'RUN_FAILED', message: 'request timed out' })?.category).toBe('network');
  });

  it('falls back to generic for unrecognized failures and keeps the raw message', () => {
    const error = classifyAgentError({
      code: 'RUN_FAILED',
      message: 'Something unexpected happened',
    });

    expect(error).toMatchObject({
      category: 'generic',
      code: 'RUN_FAILED',
      rawMessage: 'Something unexpected happened',
    });
  });

  it('prefers explicit status/trace fields and carries the current model id', () => {
    const error = classifyAgentError(
      {
        code: 'RUN_FAILED',
        message: 'AI_APICallError: Forbidden',
        statusCode: 401,
        traceId: 'trace-abc',
      },
      { modelId: 'gpt-5.2' },
    );

    // 分类仍按 message 走 forbidden，但 httpStatus 以显式字段为准，不强行写成 403
    expect(error).toMatchObject({
      category: 'forbidden',
      httpStatus: 401,
      traceId: 'trace-abc',
      modelId: 'gpt-5.2',
    });
  });
});

// 一次失败会从多个出口各发一条 error（agentOrchestrator 的 catch + runFinalizer 的
// RUN_FAILED）。真机 2026-08-01：后到的那条没带模型，把先到的带对的盖成了「当前选中
// 的模型」，卡片于是指认一个根本没跑过的模型。
describe('attachAgentErrorToLatestAssistant 多出口覆盖', () => {
  it('后到的错误没带模型时，保住先到的那条的 provider/model', () => {
    useSessionStore.setState({
      messages: [{ id: 'a1', role: 'assistant', content: '', timestamp: 1 }],
    } as never);

    attachAgentErrorToLatestAssistant({
      category: 'generic',
      rawMessage: 'boom',
      timestamp: 2,
      provider: 'openai',
      modelId: 'gpt-5-probe',
    });
    attachAgentErrorToLatestAssistant({
      category: 'generic',
      rawMessage: 'boom',
      timestamp: 3,
      modelId: 'MiniMax-M3',
    });

    const error = useSessionStore.getState().messages[0]?.metadata?.agentError;
    expect(error?.provider).toBe('openai');
    expect(error?.modelId).toBe('gpt-5-probe');
  });
});

// 宿主自起的轮次（抽干排队消息）会在轮次开头广播一条 user 消息补气泡；
// 那条一旦被当成轮末，屏幕当场显示空闲、停止按钮消失，而后台还在跑。
describe('endsTheTurn', () => {
  it('宿主补气泡的 user 消息不算轮末', () => {
    expect(endsTheTurn({ id: 'q1', role: 'user', content: '排队消息' })).toBe(false);
  });

  it('没有工具调用的 assistant 消息算轮末', () => {
    expect(endsTheTurn({ id: 'a1', role: 'assistant', content: '答完了' })).toBe(true);
  });

  it('带工具调用的 assistant 消息是轮中，不算轮末', () => {
    expect(endsTheTurn({ id: 'a1', role: 'assistant', toolCalls: [{ id: 't1' }] })).toBe(false);
  });

  it('空载荷不算', () => {
    expect(endsTheTurn(undefined)).toBe(false);
  });
});

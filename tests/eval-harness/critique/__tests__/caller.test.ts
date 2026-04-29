import { describe, expect, it, vi } from 'vitest';
import { CallerError, createOpenAICompatibleCaller } from '../caller';
import type { OpenAICompatibleCallerConfig } from '../caller';

interface MockResponseInit {
  status?: number;
  ok?: boolean;
  body?: unknown;
  text?: string;
}

function jsonResponse(content: string | null, init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const body = init.body ?? {
    choices: [{ message: { content, role: 'assistant' } }],
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, text = 'upstream error'): Response {
  return new Response(text, { status });
}

function reasoningOnlyResponse(reasoningText: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: null,
            reasoning_details: [{ type: 'reasoning.text', text: reasoningText }],
          },
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeConfig(overrides: Partial<OpenAICompatibleCallerConfig> = {}): OpenAICompatibleCallerConfig {
  return {
    apiKey: 'sk-test',
    endpoint: 'https://api.example.com/v1',
    model: 'kimi-k2.5',
    retryBaseMs: 1, // 缩到 1ms 让测试瞬时
    ...overrides,
  };
}

describe('createOpenAICompatibleCaller config validation', () => {
  it('throws when apiKey is empty', () => {
    expect(() => createOpenAICompatibleCaller(makeConfig({ apiKey: '' }))).toThrow('apiKey is required');
  });
  it('throws when endpoint is empty', () => {
    expect(() => createOpenAICompatibleCaller(makeConfig({ endpoint: '' }))).toThrow('endpoint is required');
  });
  it('throws when model is empty', () => {
    expect(() => createOpenAICompatibleCaller(makeConfig({ model: '' }))).toThrow('model is required');
  });
});

describe('createOpenAICompatibleCaller — happy path', () => {
  it('returns content from a normal 200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('hello'));
    const caller = createOpenAICompatibleCaller(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const result = await caller('prompt');
    expect(result).toBe('hello');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('strips trailing slash from endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('ok'));
    const caller = createOpenAICompatibleCaller(
      makeConfig({ endpoint: 'https://api.example.com/v1/', fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await caller('p');
    const url = (fetchImpl.mock.calls[0] as unknown as [string])[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });
});

describe('createOpenAICompatibleCaller — reasoning model fallback', () => {
  it('uses message.reasoning when content is null', async () => {
    const body = {
      choices: [{ message: { content: null, reasoning: '{"answer":"42"}' } }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    const caller = createOpenAICompatibleCaller(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const result = await caller('prompt');
    expect(result).toBe('{"answer":"42"}');
  });

  it('uses last reasoning_details[].text when content and reasoning are absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reasoningOnlyResponse('{"final":true}'));
    const caller = createOpenAICompatibleCaller(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const result = await caller('prompt');
    expect(result).toBe('{"final":true}');
  });

  it('throws empty content/reasoning when all fallback fields are missing', async () => {
    const body = { choices: [{ message: { content: null } }] };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    const caller = createOpenAICompatibleCaller(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    await expect(caller('p')).rejects.toThrow(/empty content\/reasoning/);
  });

  it('throws when response has no choices', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const caller = createOpenAICompatibleCaller(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    await expect(caller('p')).rejects.toThrow(/no choices/);
  });
});

describe('createOpenAICompatibleCaller — retry behavior', () => {
  it('retries on 500 once and succeeds on second attempt', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(jsonResponse('recovered'));
    const caller = createOpenAICompatibleCaller(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const result = await caller('p');
    expect(result).toBe('recovered');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on 502 twice and succeeds on third attempt', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(errorResponse(502))
      .mockResolvedValueOnce(errorResponse(502))
      .mockResolvedValueOnce(jsonResponse('finally'));
    const caller = createOpenAICompatibleCaller(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const result = await caller('p');
    expect(result).toBe('finally');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('throws CallerError after exhausting retries on persistent 5xx', async () => {
    // 每次返回新 Response — Response body stream 只能读一次，复用同一对象会让 .text() 后续返回 ''
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(errorResponse(503, 'overloaded')));
    const caller = createOpenAICompatibleCaller(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    let caught: unknown;
    try {
      await caller('p');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CallerError);
    const callerErr = caught as CallerError;
    expect(callerErr.status).toBe(503);
    expect(callerErr.body).toBe('overloaded');
    // retries=2 默认 → 1 初始 + 2 重试 = 3 次尝试
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries on TypeError fetch failed (network error)', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse('back'));
    const caller = createOpenAICompatibleCaller(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const result = await caller('p');
    expect(result).toBe('back');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 401 Unauthorized (4xx is not retryable)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(401, 'bad key'));
    const caller = createOpenAICompatibleCaller(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    await expect(caller('p')).rejects.toBeInstanceOf(CallerError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does NOT retry on 400 Bad Request (4xx is not retryable)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(400, 'bad payload'));
    const caller = createOpenAICompatibleCaller(makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    await expect(caller('p')).rejects.toBeInstanceOf(CallerError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries=0 disables retry entirely', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(500));
    const caller = createOpenAICompatibleCaller(
      makeConfig({ retries: 0, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await expect(caller('p')).rejects.toBeInstanceOf(CallerError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

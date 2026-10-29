// ============================================================================
// ModelRouter × OutboundSecretMask 接线（N-PROMPT-SECRET-MASK ③）
// - 开关关：provider 收到原样消息（同引用 = 请求字节不变）、onStream 同引用。
// - 开关开：provider 只见占位符；回包占位符被还原给上层。
// - fail-closed：掩码抛错 → provider.inference 一次都没被调；错误带稳定 code 且指向
//   Settings > Privacy。
// - 流式：经 router 包装的 onStream 把劈开的占位符还原后下发。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsState = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));
const moonshotInference = vi.hoisted(() => vi.fn());
const applyMaskMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/model/providers/moonshotProvider', () => ({
  MoonshotProvider: class MockMoonshotProvider {
    name = 'moonshot';
    inference = moonshotInference;
  },
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getApiKey: vi.fn().mockReturnValue('mock-api-key'),
    getSettings: () => settingsState.settings,
  }),
}));

vi.mock('../../../src/host/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({
    getHealth: vi.fn().mockReturnValue(null),
    getObservationCount: vi.fn().mockReturnValue(0),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  }),
  persistentProviderMarkKind: vi.fn(() => 'auth'),
}));

vi.mock('../../../src/host/model/inferenceCache', () => ({
  getInferenceCache: () => ({
    computeKey: vi.fn(() => 'key'),
    get: vi.fn(() => undefined),
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/host/model/adaptiveRouter', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/model/adaptiveRouter')>();
  return {
    ...actual,
    getAdaptiveRouter: () => ({
      estimateComplexity: vi.fn().mockReturnValue({ level: 'moderate', score: 50, signals: [] }),
      estimateComplexityWithJev: vi.fn(async () => ({ level: 'moderate', score: 50, signals: [] })),
      selectModel: vi.fn(),
      recordOutcome: vi.fn(),
      disableFreeModel: vi.fn(),
    }),
  };
});

// 默认透传真实现；fail-closed 用例按需让它抛（真模块的包装文案由模块单测钉住）。
vi.mock('../../../src/host/security/outboundSecretMask', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/security/outboundSecretMask')>();
  return {
    applyOutboundSecretMask: (...args: Parameters<typeof actual.applyOutboundSecretMask>) =>
      (applyMaskMock(...args) ?? actual.applyOutboundSecretMask(...args)),
  };
});

import { ModelRouter } from '../../../src/host/model/modelRouter';
import type { ModelConfig } from '../../../src/shared/contract';
import type { ModelMessage, ModelResponse, StreamChunk, StreamCallback } from '../../../src/host/model/types';

const CONFIG: ModelConfig = { provider: 'moonshot', model: 'kimi-k2.5', apiKey: 'k' };
const PLACEHOLDER_RE = /\{\{SECRET_[A-Z0-9_]+_[0-9a-f]{8}\}\}/;

function maskOn(): void {
  settingsState.settings = { privacy: { outboundSecretMask: true } };
}

function maskOff(): void {
  settingsState.settings = {};
}

describe('ModelRouter × outboundSecretMask 接线', () => {
  beforeEach(() => {
    moonshotInference.mockReset();
    applyMaskMock.mockReset();
    maskOff();
  });

  it('开关关：provider 收到原样消息与 onStream（同引用，请求字节不变）', async () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'key sk-Abc123defGHI789xyz please' },
    ];
    const captured: unknown[] = [];
    moonshotInference.mockImplementation(async (msgs: ModelMessage[]) => {
      captured.push(msgs);
      return { type: 'text', content: 'ok' } satisfies ModelResponse;
    });
    const router = new ModelRouter();
    const result = await router.inference(messages, [], CONFIG);
    expect(result.content).toBe('ok');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(messages);
  });

  it('开关关：onStream 引用原样透传（无包装）', async () => {
    const onStream: StreamCallback = () => undefined;
    let capturedStream: StreamCallback | undefined;
    moonshotInference.mockImplementation(async (_msgs, _tools, _cfg, stream?: StreamCallback) => {
      capturedStream = stream;
      return { type: 'text', content: 'ok' } satisfies ModelResponse;
    });
    const router = new ModelRouter();
    await router.inference([{ role: 'user', content: 'hi' }], [], CONFIG, onStream);
    expect(capturedStream).toBe(onStream);
  });

  it('开关开：provider 只见占位符，上层拿到还原后的回包', async () => {
    maskOn();
    const secret = 'sk-Abc123defGHI789xyz';
    const value = 'Abc123defGHI789xyz';
    const messages: ModelMessage[] = [{ role: 'user', content: `here is ${secret} review it` }];
    moonshotInference.mockImplementation(async (msgs: ModelMessage[]) => {
      const text = msgs[0].content as string;
      expect(text).not.toContain(secret);
      const placeholder = text.match(PLACEHOLDER_RE)![0];
      return { type: 'text', content: `got ${placeholder} thanks` } satisfies ModelResponse;
    });
    const router = new ModelRouter();
    const result = await router.inference(messages, [], CONFIG);
    // 占位符只替换值（sk- 前缀留在请求里），回包里也只还原出值
    expect(result.content).toBe(`got ${value} thanks`);
  });

  it('fail-closed：掩码抛错 → provider 一次都没被调，错误可读且指向设置', async () => {
    maskOn();
    // 消息字段（content/toolCallText）在掩码前就被路径决策/缓存键读取，坏 getter 红的
    // 不是掩码；这里直接让掩码入口抛真模块同款错误，验证 router 不吞、不降级明文。
    applyMaskMock.mockImplementation(() => {
      throw new Error('Outbound secret masking failed; the request was not sent. You can turn off "Mask secrets before sending to the model vendor" in Settings > Privacy. (code: OUTBOUND_SECRET_MASK_FAILED)');
    });
    moonshotInference.mockResolvedValue({ type: 'text', content: 'ok' });
    const router = new ModelRouter();
    await expect(router.inference([{ role: 'user', content: 'sk-Abc123defGHI789xyz' }], [], CONFIG))
      .rejects.toThrow(/OUTBOUND_SECRET_MASK_FAILED/);
    await expect(router.inference([{ role: 'user', content: 'sk-Abc123defGHI789xyz' }], [], CONFIG))
      .rejects.toThrow(/Settings > Privacy/);
    expect(moonshotInference).not.toHaveBeenCalled();
    applyMaskMock.mockReset();
  });

  it('流式：劈成两半的占位符还原后下发，complete 收尾', async () => {
    maskOn();
    const value = 'Abc123defGHI789xyz';
    const messages: ModelMessage[] = [{ role: 'user', content: `key sk-${value}` }];
    moonshotInference.mockImplementation(async (msgs: ModelMessage[], _tools, _cfg, onStream?: StreamCallback) => {
      const placeholder = (msgs[0].content as string).match(PLACEHOLDER_RE)![0];
      const mid = Math.floor(placeholder.length / 2);
      await onStream?.({ type: 'text', content: `you typed ${placeholder.slice(0, mid)}` });
      await onStream?.({ type: 'text', content: `${placeholder.slice(mid)} right?` });
      await onStream?.({ type: 'complete', finishReason: 'stop' });
      return { type: 'text', content: `you typed ${value} right?` } satisfies ModelResponse;
    });
    const seen: StreamChunk[] = [];
    const onStream: StreamCallback = (chunk) => {
      if (typeof chunk !== 'string') seen.push(chunk);
    };
    const router = new ModelRouter();
    const result = await router.inference(messages, [], CONFIG, onStream);
    const text = seen
      .filter((chunk) => chunk.type === 'text')
      .map((chunk) => chunk.content ?? '')
      .join('');
    expect(text).toBe(`you typed ${value} right?`);
    expect(seen[seen.length - 1].type).toBe('complete');
    expect(result.content).toBe(`you typed ${value} right?`);
  });
});

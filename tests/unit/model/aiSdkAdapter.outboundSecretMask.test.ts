// ============================================================================
// inferenceViaAiSdk × OutboundSecretMask 接线（N-PROMPT-SECRET-MASK Rework r1）
// 主 loop / provider fallback / 子代理的默认模型入口是 AI SDK 适配器而非
// ModelRouter._callProvider——开关在这里不开就是假承诺。锁住：
// - 开关关：SDK 收到原样请求（文本未被改写）、onStream 原样透传（请求字节不变）。
// - 开关开：底层 SDK 只见占位符；流式/回包还原给上层（含劈开的占位符分片）。
// - fail-closed：掩码抛错 → streamText/generateText 一次都没被调，错误带稳定 code
//   且指向 Settings > Privacy。
// - zhipu limiter 分支同样掩码/还原（inferenceViaAiSdk 的另一条控制流）。
// - 占位符二次掩码是 no-op（两路叠加不会双重替换）。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamText, generateText } from 'ai';

const settingsState = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));
const applyMaskMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// baseURL/apiKey 解析与本测试无关：固定返回，避免依赖 configService/env。
vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderBaseUrl: () => 'https://test.local/v1',
  resolveProviderApiKey: () => 'test-key',
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => settingsState.settings,
    getApiKey: vi.fn().mockReturnValue('test-key'),
    getProviderSettings: vi.fn().mockReturnValue({}),
  }),
}));

// 只桩掉 streamText / generateText，保留 tool()/jsonSchema 等真实实现（buildTools 依赖）。
vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>();
  return { ...actual, streamText: vi.fn(), generateText: vi.fn() };
});

// 默认透传真实现；fail-closed 用例按需让它抛（真模块的包装文案由模块单测钉住）。
vi.mock('../../../src/host/security/outboundSecretMask', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/security/outboundSecretMask')>();
  return {
    applyOutboundSecretMask: (...args: Parameters<typeof actual.applyOutboundSecretMask>) =>
      (applyMaskMock(...args) ?? actual.applyOutboundSecretMask(...args)),
  };
});

import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import { applyOutboundSecretMask } from '../../../src/host/security/outboundSecretMask';
import type { StreamChunk, StreamCallback } from '../../../src/host/model/types';
import type { ModelConfig } from '../../../src/shared/contract';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
import type { ModelMessage } from '../../../src/host/model/types';

const SECRET = 'sk-Abc123defGHI789xyz';
const VALUE = 'Abc123defGHI789xyz';
const PLACEHOLDER_RE = /\{\{SECRET_[A-Z0-9_]+_[0-9a-f]{8}\}\}/;
const NO_LIMITER: ModelConfig = { provider: 'xiaomi', model: 'mimo-v2.5-pro' } as ModelConfig;
// zhipu 是唯一有出厂并发上限的 provider → 走 inferenceViaAiSdk 的 limiter 分支。
const ZHIPU: ModelConfig = { provider: 'zhipu', model: 'glm-4.7' } as ModelConfig;

function maskOn(): void {
  settingsState.settings = { privacy: { outboundSecretMask: true } };
}

function maskOff(): void {
  settingsState.settings = {};
}

/** 用一组受控事件构造 streamText 返回值（只实现被消费的 stream）。 */
function fakeStream(parts: unknown[]) {
  return {
    stream: (async function* () {
      for (const p of parts) yield p;
    })(),
  } as unknown as ReturnType<typeof streamText>;
}

/** 收集 onStream 回调，按 type 分桶便于断言。 */
function makeCollector() {
  const chunks: StreamChunk[] = [];
  const onStream: StreamCallback = (c) => {
    if (typeof c !== 'string') chunks.push(c);
  };
  return {
    onStream,
    chunks,
    texts: () => chunks.filter((c) => c.type === 'text').map((c) => c.content).join(''),
  };
}

/** streamText 收到的 prompt 文本（instructions + messages 全量 JSON）——SDK 视角的请求体。 */
function sdkPromptText(): string {
  expect(streamText).toHaveBeenCalled();
  const call = vi.mocked(streamText).mock.calls[0][0] as unknown as Record<string, unknown>;
  return JSON.stringify({ instructions: call.instructions, messages: call.messages });
}

beforeEach(() => {
  vi.mocked(streamText).mockReset();
  vi.mocked(generateText).mockReset();
  applyMaskMock.mockReset();
  maskOff();
});

describe('inferenceViaAiSdk × outboundSecretMask 接线', () => {
  it('开关关：SDK 收到原样文本、onStream 同引用透传、回包不包还原层', async () => {
    const messages: ModelMessage[] = [{ role: 'user', content: `key ${SECRET} review it` }];
    vi.mocked(streamText).mockReturnValue(fakeStream([
      { type: 'text-delta', text: 'ok' },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
    ]));
    const collector = makeCollector();
    const result = await inferenceViaAiSdk(messages, [], NO_LIMITER, collector.onStream);
    // 掩码入口被调过（读到开关=关），messages/onStream 都是同引用
    expect(applyMaskMock).toHaveBeenCalledWith(messages, collector.onStream);
    // SDK 请求文本仍是原文（请求字节不变）
    expect(sdkPromptText()).toContain(SECRET);
    expect(sdkPromptText()).not.toMatch(PLACEHOLDER_RE);
    expect(result.content).toBe('ok');
    expect(collector.texts()).toBe('ok');
  });

  it('开关开（流式）：SDK 只见占位符，劈开的占位符分片还原后下发，回包还原', async () => {
    maskOn();
    const messages: ModelMessage[] = [{ role: 'user', content: `key ${SECRET} review it` }];
    // 模型只回占位符：先发前半，再发后半 + 尾巴（占位符跨 chunk 劈开）
    vi.mocked(streamText).mockImplementation((...args: unknown[]) => {
      const call = args[0] as Record<string, unknown>;
      const prompt = JSON.stringify({ instructions: call.instructions, messages: call.messages });
      const placeholder = prompt.match(PLACEHOLDER_RE)![0];
      const mid = Math.floor(placeholder.length / 2);
      return fakeStream([
        { type: 'text-delta', text: 'you typed ' },
        { type: 'text-delta', text: placeholder.slice(0, mid) },
        { type: 'text-delta', text: `${placeholder.slice(mid)} right?` },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]);
    });
    const collector = makeCollector();
    const result = await inferenceViaAiSdk(messages, [], NO_LIMITER, collector.onStream);
    // SDK 请求文本：无原文、有占位符（sk- 前缀留明文，只有值被替换）
    const prompt = sdkPromptText();
    expect(prompt).not.toContain(SECRET);
    const placeholder = prompt.match(PLACEHOLDER_RE)![0];
    expect(prompt).toContain(placeholder);
    // 流式与最终回包都还原成原值
    expect(collector.texts()).toBe(`you typed ${VALUE} right?`);
    expect(result.content).toBe(`you typed ${VALUE} right?`);
    expect(result.contentParts?.[0]).toEqual({ type: 'text', text: `you typed ${VALUE} right?` });
  });

  it('开关开（非流式 generateText）：回包占位符还原', async () => {
    maskOn();
    vi.mocked(generateText).mockImplementation(async () => {
      // 模型回显占位符：从掩码现场拿一个（同值同占位符）
      const masked = applyOutboundSecretMask(
        [{ role: 'user', content: `key ${SECRET}` }] as ModelMessage[],
      );
      const placeholder = (masked!.messages[0].content as string).match(PLACEHOLDER_RE)![0];
      return { text: `got ${placeholder} thanks`, toolCalls: [], usage: {} } as unknown as Awaited<ReturnType<typeof generateText>>;
    });
    const result = await inferenceViaAiSdk(
      [{ role: 'user', content: `key ${SECRET} review it` }],
      [],
      NO_LIMITER,
    );
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    // 调用方拿到还原后的文本
    expect(result.content).toBe(`got ${VALUE} thanks`);
    // SDK 侧请求文本只见占位符
    const call = vi.mocked(generateText).mock.calls[0][0] as unknown as Record<string, unknown>;
    const prompt = JSON.stringify({ instructions: call.instructions, messages: call.messages });
    expect(prompt).not.toContain(SECRET);
    expect(prompt).toMatch(PLACEHOLDER_RE);
  });

  it('fail-closed：掩码抛错 → SDK 一次都没被调，错误可读且指向设置', async () => {
    maskOn();
    applyMaskMock.mockImplementation(() => {
      throw new Error('Outbound secret masking failed; the request was not sent. You can turn off "Mask secrets before sending to the model vendor" in Settings > Privacy. (code: OUTBOUND_SECRET_MASK_FAILED)');
    });
    await expect(inferenceViaAiSdk(
      [{ role: 'user', content: `key ${SECRET}` }],
      [],
      NO_LIMITER,
      makeCollector().onStream,
    )).rejects.toThrow(/OUTBOUND_SECRET_MASK_FAILED/);
    await expect(inferenceViaAiSdk([{ role: 'user', content: `key ${SECRET}` }], [], NO_LIMITER))
      .rejects.toThrow(/Settings > Privacy/);
    expect(vi.mocked(streamText)).not.toHaveBeenCalled();
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    applyMaskMock.mockReset();
  });

  it('zhipu limiter 分支：同样掩码出云、还原回包', async () => {
    maskOn();
    vi.mocked(generateText).mockImplementation(async () => {
      const masked = applyOutboundSecretMask([{ role: 'user', content: `key ${SECRET}` }] as ModelMessage[]);
      const placeholder = (masked!.messages[0].content as string).match(PLACEHOLDER_RE)![0];
      return { text: `echo ${placeholder}`, toolCalls: [], usage: {} } as unknown as Awaited<ReturnType<typeof generateText>>;
    });
    const result = await inferenceViaAiSdk(
      [{ role: 'user', content: `key ${SECRET} review it` }],
      [],
      ZHIPU,
    );
    expect(result.content).toBe(`echo ${VALUE}`);
    const call = vi.mocked(generateText).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(call.messages)).not.toContain(SECRET);
  });

  it('两路叠加保险：已掩码的占位符文本二次进掩码是 no-op（不双重替换）', async () => {
    maskOn();
    // 第一层掩码现场（模拟 _callProvider 先掩、provider 内部又调 aiSdk 入口的叠加形状）
    const once = applyOutboundSecretMask([{ role: 'user', content: `key ${SECRET}` }] as ModelMessage[])!;
    const onceText = once.messages[0].content as string;
    const placeholder = onceText.match(PLACEHOLDER_RE)![0];
    // 第二层：对已掩码消息再过一次掩码入口 → 文本不变
    const twice = applyOutboundSecretMask([{ role: 'user', content: onceText }] as ModelMessage[]);
    expect(twice!.messages[0].content as string).toBe(onceText);
    // 接线层面：把已掩码消息发给 SDK，请求文本保持同一占位符
    vi.mocked(streamText).mockReturnValue(fakeStream([
      { type: 'text-delta', text: 'ok' },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
    ]));
    const result: ModelResponse = await inferenceViaAiSdk(
      [{ role: 'user', content: onceText }],
      [],
      NO_LIMITER,
      makeCollector().onStream,
    );
    const prompt = sdkPromptText();
    expect(prompt).toContain(placeholder);
    expect(prompt).not.toContain(SECRET);
    expect(result.content).toBe('ok');
  });
});

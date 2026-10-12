// N-MODELCAT-GPT6-SOL：GPT-6 Sol / GPT-6.1 Sol 的目录登记、Responses 协议路由与
// reasoning.effort 下发。数据源：OpenAI 官方模型页（抓取 2026-09-30）
//   https://developers.openai.com/api/docs/models/gpt-6-sol
//   https://developers.openai.com/api/docs/models/gpt-6.1-sol
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/model/providers/providerHttp', () => ({ electronFetch }));

import { PROVIDER_REGISTRY } from '../../../src/host/model/providerRegistry';
import { resolveModelCapabilities } from '../../../src/host/model/modelCapabilityMatrix';
import { ResponsesProvider } from '../../../src/host/model/providers/responsesProvider';
import { logger } from '../../../src/host/model/providers/providerRuntime';
import { applyEffortControls } from '../../../src/host/agent/runtime/contextAssembly/effortControls';
import {
  CONTEXT_WINDOWS,
  MODEL_ABBREV,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_PRICING_PER_1M,
  PRICING_TABLE_VERSION,
} from '../../../src/shared/constants';
import catalogJson from '../../../src/shared/model-catalog.json';

interface CatalogModel { id: string; label: string; group?: string; desc?: string; scaffoldTier?: string }
const openaiCatalog = (catalogJson.providers.find((p) => p.id === 'openai')!.models as CatalogModel[]);

describe('GPT-6 Sol catalogue entries', () => {
  it('registers both ids under openai with the official figures', () => {
    for (const [id, name] of [['gpt-6-sol', 'GPT-6 Sol'], ['gpt-6.1-sol', 'GPT-6.1 Sol']] as const) {
      const entry = PROVIDER_REGISTRY.openai?.models.find((model) => model.id === id);
      expect(entry, id).toBeDefined();
      expect(entry!.name).toBe(name);
      expect(entry!.maxTokens).toBe(128000);
      expect(entry!.supportsTool).toBe(true);
      expect(entry!.supportsStreaming).toBe(true);
      // 官方输入为 Text+Image，但 Responses 的 input 转换目前只送文本——协议能送图前不标 vision。
      expect(entry!.supportsVision).toBe(false);
      expect(entry!.capabilities).toEqual(['general', 'code', 'reasoning']);
      expect(entry!.thinking).toEqual({
        kind: 'effort',
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
      });
      expect(MODEL_MAX_OUTPUT_TOKENS[id]).toBe(128000);
      expect(CONTEXT_WINDOWS[id]).toBe(1_050_000);
      expect(MODEL_ABBREV[id]).toBeDefined();
    }
  });

  it('keeps the gpt-5.5 effort declaration identical to the pre-refactor shape', () => {
    const gpt55 = PROVIDER_REGISTRY.openai?.models.find((model) => model.id === 'gpt-5.5');
    expect(gpt55!.thinking).toEqual({ kind: 'effort', levels: ['low', 'medium', 'high'] });
  });

  it('lists both in the picker catalogue under GPT 系列 with the 1.05M context', () => {
    for (const id of ['gpt-6-sol', 'gpt-6.1-sol']) {
      const entry = openaiCatalog.find((model) => model.id === id);
      expect(entry, id).toBeDefined();
      expect(entry!.group).toBe('GPT 系列');
      expect(entry!.scaffoldTier).toBe('strong');
      expect(entry!.desc).toContain('1.05M');
    }
  });

  it('carries exact pricing rows for both Sol ids', () => {
    expect(MODEL_PRICING_PER_1M['gpt-6.1-sol']).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      longContext: { thresholdPromptTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5, cacheMultiplier: 2 },
    });
    expect(MODEL_PRICING_PER_1M['gpt-6-sol']).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      longContext: { thresholdPromptTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5, cacheMultiplier: 2 },
    });
    expect(PRICING_TABLE_VERSION).toBe(3);
  });

  it('switches both Sol ids onto the responses protocol while gpt-5.5 stays chat-completions', () => {
    // 官方要求工具调用走 Responses API；矩阵按模型切协议。
    expect(resolveModelCapabilities('openai', 'gpt-6-sol').protocol).toBe('responses');
    expect(resolveModelCapabilities('openai', 'gpt-6.1-sol').protocol).toBe('responses');
    expect(resolveModelCapabilities('openai', 'gpt-5.5').protocol).toBe('chat-completions');
  });
});

describe('ResponsesProvider reasoning effort', () => {
  let provider: ResponsesProvider;

  beforeEach(() => {
    electronFetch.mockReset();
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
    provider = new ResponsesProvider();
  });

  async function sentRawBody(config: Record<string, unknown>): Promise<string> {
    await provider.inference([{ role: 'user', content: 'hi' }], [], config as any);
    return electronFetch.mock.calls.at(-1)![1].body as string;
  }

  it('sends reasoning.effort for the declared xhigh and max levels', async () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const body = JSON.parse(await sentRawBody({
        provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses', reasoningEffort: effort,
      }));
      expect(body.reasoning).toEqual({ effort });
      expect(body.store).toBe(false);
    }
    const sol6 = JSON.parse(await sentRawBody({
      provider: 'openai', model: 'gpt-6-sol', apiKey: 'k', protocol: 'responses', reasoningEffort: 'xhigh',
    }));
    expect(sol6.reasoning).toEqual({ effort: 'xhigh' });
  });

  it('clamps ultra_code to high through applyEffortControls before the request', async () => {
    const config = applyEffortControls(
      { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses' } as any,
      'ultra_code',
    );
    expect(config.reasoningEffort).toBe('high');
    const body = JSON.parse(await sentRawBody(config as any));
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('omits the reasoning key when no effort is set', async () => {
    const raw = await sentRawBody({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses' });
    expect(JSON.parse(raw)).not.toHaveProperty('reasoning');
  });

  it('keeps the deepseek-flash Responses body byte-identical even with an effort set', async () => {
    // deepseek-flash 未显式声明 effort 档位：reasoningEffort 在场也不得改变请求体一个字节。
    const baseline = await sentRawBody({ provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', protocol: 'responses' });
    const withEffort = await sentRawBody({
      provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', protocol: 'responses', reasoningEffort: 'xhigh',
    });
    expect(withEffort).toBe(baseline);
    expect(JSON.parse(withEffort)).not.toHaveProperty('reasoning');
  });
});

// PR #2298 rework r2：store:false 的无状态工具循环里，OpenAI 推理模型的 rs_ reasoning 项
// 只有带 encrypted_content 才能合法回放；不带 include 请求攒下的推理项回放会被服务端以
// 'Item rs_… not found, items are not persisted when store=false' 拒掉，工具循环第二轮即断。
describe('ResponsesProvider stateless reasoning replay (store:false)', () => {
  let provider: ResponsesProvider;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    electronFetch.mockReset();
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }) });
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    provider = new ResponsesProvider();
  });

  async function sentInput(body: { messages: unknown[]; config: Record<string, unknown> }): Promise<unknown[]> {
    await provider.inference(body.messages as any, [], body.config as any);
    return JSON.parse(electronFetch.mock.calls.at(-1)![1].body as string).input;
  }

  const toolLoopHistory = (reasoningItem: Record<string, unknown>) => ([
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: '', responsesOutput: [
      reasoningItem,
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
    ] },
    { role: 'tool', toolCallId: 'call_1', content: 'file contents' },
  ]);

  it('asks for encrypted reasoning content on both Sol ids, with or without an explicit effort', async () => {
    for (const model of ['gpt-6-sol', 'gpt-6.1-sol']) {
      for (const reasoningEffort of [undefined, 'xhigh'] as const) {
        await provider.inference([{ role: 'user', content: 'hi' }], [], {
          provider: 'openai', model, apiKey: 'k', protocol: 'responses',
          ...(reasoningEffort ? { reasoningEffort } : {}),
        } as any);
        const body = JSON.parse(electronFetch.mock.calls.at(-1)![1].body as string);
        expect(body.include, `${model} effort=${reasoningEffort}`).toEqual(['reasoning.encrypted_content']);
        expect(body.store).toBe(false);
      }
    }
  });

  it('drops replayed reasoning items without encrypted_content on the tool-result continuation turn', async () => {
    const input = await sentInput({
      messages: toolLoopHistory({ type: 'reasoning', id: 'rs_1', summary: [] }),
      config: { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses' },
    });
    expect(input).toEqual([
      { role: 'user', content: 'read it' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('rs_1'),
      expect.objectContaining({ itemId: 'rs_1', messageIndex: 1 }),
    );
  });

  it('keeps replaying reasoning items that carry encrypted_content, verbatim', async () => {
    const encrypted = { type: 'reasoning', id: 'rs_2', encrypted_content: 'gAAAAA', summary: [] };
    const input = await sentInput({
      messages: toolLoopHistory(encrypted),
      config: { provider: 'openai', model: 'gpt-6-sol', apiKey: 'k', protocol: 'responses' },
    });
    expect(input).toContainEqual(encrypted);
  });

  it('leaves deepseek-flash replay untouched: no include, unencrypted reasoning items still replayed', async () => {
    const input = await sentInput({
      messages: toolLoopHistory({ type: 'reasoning', id: 'rs_1', summary: [] }),
      config: { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', protocol: 'responses' },
    });
    const body = JSON.parse(electronFetch.mock.calls.at(-1)![1].body as string);
    expect(body).not.toHaveProperty('include');
    expect(input).toContainEqual({ type: 'reasoning', id: 'rs_1', summary: [] });
  });
});

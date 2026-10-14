// N-MODELCAT-SERVICE-TIER-WIRE：Responses 请求的 service_tier 下发与档位拒绝回落。
// N-MODELCAT-SERVICE-TIER-COST：响应实报档位流向 usage（预算层按档计费）。
// 全程 mock electronFetch（零网络调用）；真调用错误体与未验证信号的范围见
// src/shared/constants/serviceTier.ts。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/model/providers/providerHttp', () => ({ electronFetch }));

import { ResponsesProvider } from '../../../src/host/model/providers/responsesProvider';
import { logger } from '../../../src/host/model/providers/providerRuntime';
import {
  SERVICE_TIER_REJECTION,
  UNATTENDED_SERVICE_TIER,
  computeUsageCostUsd,
  MODEL_PRICING_PER_1M,
} from '../../../src/shared/constants';

// 改动前（HEAD 8eebf5f95 实测抓取）的逐字节请求体——默认路径必须与它一字不差。
const PRECHANGE_OPENAI_BODY = '{"model":"gpt-6.1-sol","input":[{"role":"user","content":"hi"}],"store":false,"include":["reasoning.encrypted_content"]}';
const PRECHANGE_DEEPSEEK_BODY = '{"model":"deepseek-v4-flash","input":[{"role":"user","content":"hi"}],"store":false,"tools":[{"type":"web_search"}]}';

// Exact HTTP 400 body captured from POST /v1/responses on 2026-10-14.
// N-MODELCAT-SERVICE-TIER-REALCALL: gpt-6.1-sol, service_tier=flex_invalid.
const REAL_TIER_REJECTION_BODY = `{
  "error": {
    "message": "Invalid value: 'flex_invalid'. Supported values are: 'auto', 'default', 'fast', 'flex', and 'priority'.",
    "type": "invalid_request_error",
    "param": "service_tier",
    "code": "invalid_value"
  }
}`;

function okResponse() {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue({ output: [] }), text: vi.fn() };
}

function rejectionResponse(status: number, error: Record<string, unknown>) {
  return { ok: false, status, text: vi.fn().mockResolvedValue(JSON.stringify({ error })) };
}

async function sentBodies(config: Record<string, unknown>): Promise<string[]> {
  const callsBefore = electronFetch.mock.calls.length;
  await new ResponsesProvider().inference([{ role: 'user', content: 'hi' }], [], config as any);
  return electronFetch.mock.calls.slice(callsBefore).map((call) => call[1].body as string);
}

describe('ResponsesProvider service_tier (N-MODELCAT-SERVICE-TIER-WIRE)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    electronFetch.mockReset();
    electronFetch.mockResolvedValue(okResponse());
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    warnSpy.mockClear();
  });

  it('默认（config 不带档）请求逐字节等于改动前：无 service_tier 键', async () => {
    const [openaiBody] = await sentBodies({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses' });
    expect(openaiBody).toBe(PRECHANGE_OPENAI_BODY);
    expect(JSON.parse(openaiBody)).not.toHaveProperty('service_tier');

    const [deepseekBody] = await sentBodies({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'k', protocol: 'responses' });
    expect(deepseekBody).toBe(PRECHANGE_DEEPSEEK_BODY);
    expect(JSON.parse(deepseekBody)).not.toHaveProperty('service_tier');
  });

  it('config.serviceTier 在场才下发 service_tier，其余键序不变', async () => {
    const [body] = await sentBodies({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses', serviceTier: UNATTENDED_SERVICE_TIER });
    expect(JSON.parse(body).service_tier).toBe(UNATTENDED_SERVICE_TIER);
    // 只多一个尾键：前缀与默认请求逐字节一致（service_tier 追加在键序末尾）。
    expect(body).toBe(PRECHANGE_OPENAI_BODY.slice(0, -1) + `,"service_tier":"${UNATTENDED_SERVICE_TIER}"}`);
  });

  it.each([
    ['HTTP 400 + error.code=unsupported_value', 400, { code: 'unsupported_value', param: 'service_tier', message: 'Unsupported value: flex' }],
    ['HTTP 422 + error.param=service_tier', 422, { param: 'service_tier', message: 'Invalid parameter' }],
    ['HTTP 429 + error.code=resource_unavailable（flex 当前不可用）', 429, { code: 'resource_unavailable', message: 'Service tier flex is currently at capacity' }],
  ])('档位拒绝（%s）→ warn 留痕并摘档重试一次', async (_label, status, error) => {
    electronFetch
      .mockResolvedValueOnce(rejectionResponse(status as number, error))
      .mockResolvedValueOnce(okResponse());

    await sentBodies({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses', serviceTier: 'flex' });

    expect(electronFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(electronFetch.mock.calls[0][1].body).service_tier).toBe('flex');
    expect(JSON.parse(electronFetch.mock.calls[1][1].body)).not.toHaveProperty('service_tier');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('service_tier rejected'),
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-6.1-sol',
        status,
        code: (error as Record<string, unknown>).code ?? (error as Record<string, unknown>).param,
      }),
    );
  });

  it.each(['flex_invalid', UNATTENDED_SERVICE_TIER])('replays the exact real rejection for %s and retries once without the tier', async (tier) => {
    const rejected = new Response(REAL_TIER_REJECTION_BODY, { status: 400 });
    const readError = vi.spyOn(rejected, 'text');
    electronFetch
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(okResponse());

    const bodies = await sentBodies({
      provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses', serviceTier: tier,
    });

    expect(electronFetch).toHaveBeenCalledTimes(2);
    expect(readError).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toBe(PRECHANGE_OPENAI_BODY.slice(0, -1) + `,"service_tier":"${tier}"}`);
    expect(bodies[1]).toBe(PRECHANGE_OPENAI_BODY);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[ResponsesProvider] service_tier rejected; retrying once at the standard tier',
      { provider: 'openai', model: 'gpt-6.1-sol', status: 400, code: 'invalid_value', serviceTier: tier },
    );
  });

  it('stops after one retry when the exact real rejection repeats', async () => {
    electronFetch.mockImplementation(async () => new Response(REAL_TIER_REJECTION_BODY, { status: 400 }));

    await expect(sentBodies({
      provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses', serviceTier: UNATTENDED_SERVICE_TIER,
    })).rejects.toThrow(`Responses API (400): ${REAL_TIER_REJECTION_BODY}`);
    expect(electronFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(electronFetch.mock.calls[1][1].body)).not.toHaveProperty('service_tier');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('重试后的标准档请求仍失败 → 原样抛第二个错误，不再重试', async () => {
    electronFetch
      .mockResolvedValueOnce(rejectionResponse(400, { code: 'unsupported_value', param: 'service_tier' }))
      .mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('upstream exploded') });

    await expect(sentBodies({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses', serviceTier: 'flex' }))
      .rejects.toThrow('Responses API (500): upstream exploded');
    expect(electronFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['error.param 指向别的参数', 400, { param: 'model', code: 'model_not_found' }],
    ['error.code 不在信号集', 400, { code: 'context_length_exceeded', param: 'messages' }],
    ['状态码不在信号集', 401, { code: 'unsupported_value', param: 'service_tier' }],
    ['error 体不是 JSON', 400, null],
  ])('非档位拒绝（%s）→ 只发一次、错误原样抛、无 warn', async (_label, status, error) => {
    electronFetch.mockResolvedValueOnce({
      ok: false, status: status as number,
      text: vi.fn().mockResolvedValue(error === null ? '<html>Bad Gateway</html>' : JSON.stringify({ error })),
    });

    await expect(sentBodies({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses', serviceTier: 'flex' }))
      .rejects.toThrow(`Responses API (${status})`);
    expect(electronFetch).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('不带档的请求撞上同形错误 → 不触发摘档重试（本来就没档）', async () => {
    electronFetch.mockResolvedValueOnce(rejectionResponse(400, { code: 'unsupported_value', param: 'service_tier' }));

    await expect(sentBodies({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses' }))
      .rejects.toThrow('Responses API (400)');
    expect(electronFetch).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('拒绝信号集常量保持声明的形状（防漂移）', () => {
    expect(SERVICE_TIER_REJECTION).toEqual({
      paramStatuses: [400, 422],
      param: 'service_tier',
      codes: ['unsupported_value', 'invalid_value'],
      codeStatuses: [400, 422],
      unavailable: { status: 429, code: 'resource_unavailable' },
    });
  });
});

// N-MODELCAT-SERVICE-TIER-COST：响应实报 service_tier 挂上 usage 流向预算层——
// 预算按「响应实际用的档」计价，不按「请求想用的档」。REALCALL（PR #2406）：
// gpt-6.1-sol flex 响应 usage 9 in / 6 out，flex 价 $1/M、$5/M = 标准价 0.5x。
describe('ResponsesProvider 响应档位流向 usage（N-MODELCAT-SERVICE-TIER-COST）', () => {
  // REALCALL 实测的 flex 响应形状（output 略）
  const REALCALL_FLEX_PAYLOAD = {
    output: [],
    usage: { input_tokens: 9, output_tokens: 6 },
    service_tier: 'flex',
  };
  const GPT_6_1_SOL_PRICING = MODEL_PRICING_PER_1M['gpt-6.1-sol'];

  beforeEach(() => {
    electronFetch.mockReset();
  });

  it('非流式：flex 响应的 usage 带 serviceTier，按 0.5x 计价（$0.000039）', async () => {
    electronFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue(REALCALL_FLEX_PAYLOAD) });

    const result = await new ResponsesProvider().inference(
      [{ role: 'user', content: 'hi' }], [],
      { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses', serviceTier: UNATTENDED_SERVICE_TIER } as any,
    );

    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 6, serviceTier: 'flex' });
    const cost = computeUsageCostUsd(GPT_6_1_SOL_PRICING, result.usage!);
    expect(cost).toBe(0.000039);
    expect(cost).toBe(computeUsageCostUsd(GPT_6_1_SOL_PRICING, { inputTokens: 9, outputTokens: 6 }) * 0.5);
  });

  it('流式：response.completed 里的 service_tier 同样落到 usage', async () => {
    const sse = [
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 9, output_tokens: 6 }, service_tier: 'flex' },
      })}`,
      'data: [DONE]',
    ].join('\n\n');
    electronFetch.mockResolvedValue(new Response(sse, { status: 200 }));

    const usageChunks: unknown[] = [];
    const result = await new ResponsesProvider().inference(
      [{ role: 'user', content: 'hi' }], [],
      { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses', serviceTier: UNATTENDED_SERVICE_TIER } as any,
      (chunk) => { if (typeof chunk === 'object' && chunk.type === 'usage') usageChunks.push(chunk); },
    );

    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 6, serviceTier: 'flex' });
    expect(computeUsageCostUsd(GPT_6_1_SOL_PRICING, result.usage!)).toBe(0.000039);
    expect(usageChunks).toEqual([{ type: 'usage', inputTokens: 9, outputTokens: 6, serviceTier: 'flex' }]);
  });

  it('被拒摘档重试后：重试响应（无 service_tier）记 standard 价（②验收）', async () => {
    electronFetch
      .mockResolvedValueOnce(new Response(REAL_TIER_REJECTION_BODY, { status: 400 }))
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: vi.fn().mockResolvedValue({ output: [], usage: { input_tokens: 9, output_tokens: 6 }, service_tier: 'standard' }),
      });

    const result = await new ResponsesProvider().inference(
      [{ role: 'user', content: 'hi' }], [],
      { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses', serviceTier: 'flex' } as any,
    );

    expect(electronFetch).toHaveBeenCalledTimes(2);
    // 重试响应实报 standard：档位在场但计价倍率 = 1（与缺席逐位一致）
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 6, serviceTier: 'standard' });
    expect(computeUsageCostUsd(GPT_6_1_SOL_PRICING, result.usage!))
      .toBe(computeUsageCostUsd(GPT_6_1_SOL_PRICING, { inputTokens: 9, outputTokens: 6 }));
    expect(computeUsageCostUsd(GPT_6_1_SOL_PRICING, result.usage!)).toBe(0.000078);
  });

  it('无档响应（服务端不回 service_tier 字段）：usage 不带档位键，计价不变', async () => {
    electronFetch.mockResolvedValue({
      ok: true, status: 200,
      json: vi.fn().mockResolvedValue({ output: [], usage: { input_tokens: 9, output_tokens: 6 } }),
    });

    const result = await new ResponsesProvider().inference(
      [{ role: 'user', content: 'hi' }], [],
      { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'k', protocol: 'responses' } as any,
    );

    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 6 });
    expect(computeUsageCostUsd(GPT_6_1_SOL_PRICING, result.usage!)).toBe(0.000078);
  });
});

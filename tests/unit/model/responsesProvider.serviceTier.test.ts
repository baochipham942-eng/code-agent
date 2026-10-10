// N-MODELCAT-SERVICE-TIER-WIRE：Responses 请求的 service_tier 下发与档位拒绝回落。
// 全程 mock electronFetch（零真机调用）；拒绝信号集 UNVERIFIED 的说明见
// src/shared/constants/serviceTier.ts。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/model/providers/providerHttp', () => ({ electronFetch }));

import { ResponsesProvider } from '../../../src/host/model/providers/responsesProvider';
import { logger } from '../../../src/host/model/providers/providerRuntime';
import { SERVICE_TIER_REJECTION, UNATTENDED_SERVICE_TIER } from '../../../src/shared/constants';

// 改动前（HEAD 8eebf5f95 实测抓取）的逐字节请求体——默认路径必须与它一字不差。
const PRECHANGE_OPENAI_BODY = '{"model":"gpt-6.1-sol","input":[{"role":"user","content":"hi"}],"store":false,"include":["reasoning.encrypted_content"]}';
const PRECHANGE_DEEPSEEK_BODY = '{"model":"deepseek-v4-flash","input":[{"role":"user","content":"hi"}],"store":false,"tools":[{"type":"web_search"}]}';

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

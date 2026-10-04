// ADR-068 follow-up（N-STREAM-RESUME-DOGFOOD）：prefix-param 档的请求参数名按能力表
// streamResume.param 分发——'prefix'（deepseek 顶层 body 键，缺省）与 'partial'
// （moonshot Partial Mode，打在末条 assistant 消息上）。锁住：
//  - deepseek B1 续接 body 与 origin/main 逐字节一致（顶层 prefix:true + reasoning_content
//    回填，键序固定），正常请求（末条 user/tool）不注入；
//  - moonshot B1 续接 body：partial:true 只在末条 assistant 消息上，顶层无 prefix 键，
//    其余消息原样，采样默认值（temp=1.0/top_p=0.95）不受影响；正常请求无 partial；
//  - 非 prefix-param 档（unknown 等）transform 直通，不注入任何续接参数。
import { describe, expect, it } from 'vitest';
import { buildVendorCompatSettings } from '../../../src/host/model/adapters/aiSdkVendorCompat';
import type { ModelConfig } from '../../../src/shared/contract';

/** B1 续接请求的独有形状：末条 assistant（断点文本前缀）。 */
const resumeBody = (model: string) => ({
  model,
  messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'partial' }],
});

describe('withStreamResumePrefixCompat —— prefix-param 参数名按能力表分发', () => {
  it('deepseek：B1 续接 body 逐字节锁死（origin/main 形状），endpointPath 仍为 /beta', () => {
    const cfg = { provider: 'deepseek', model: 'deepseek-chat' } as ModelConfig;
    const transform = buildVendorCompatSettings(cfg).transformRequestBody!;
    // 期望串即 origin/main 输出：deepseek 代码路径本次零改动（param 缺省 'prefix'），
    // 逐字节相等即证明 wire bytes 未漂移（端点 /beta 由矩阵测试与 adapter 测试钉死）。
    expect(JSON.stringify(transform(resumeBody('deepseek-chat')))).toBe(
      '{"model":"deepseek-chat","messages":[{"role":"user","content":"x"},{"role":"assistant","content":"partial","reasoning_content":""}],"prefix":true}',
    );
  });

  it('deepseek：正常请求（末条 user / tool）不注入 prefix', () => {
    const cfg = { provider: 'deepseek', model: 'deepseek-chat' } as ModelConfig;
    const transform = buildVendorCompatSettings(cfg).transformRequestBody!;
    const userLast = transform({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }] });
    expect(userLast).not.toHaveProperty('prefix');
    const toolLast = transform({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: 'ok', tool_call_id: 'c1' }],
    });
    expect(toolLast).not.toHaveProperty('prefix');
  });

  it('moonshot：partial:true 只在末条 assistant 消息上，顶层无 prefix，采样默认值保留', () => {
    const cfg = { provider: 'moonshot', model: 'kimi-k2.6' } as ModelConfig;
    const transform = buildVendorCompatSettings(cfg).transformRequestBody!;
    const out = transform(resumeBody('kimi-k2.6')) as Record<string, unknown>;
    expect(out).not.toHaveProperty('prefix');
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[messages.length - 1]).toEqual({ role: 'assistant', content: 'partial', partial: true });
    // 其余消息不打标（Moonshot 合同只认末条）
    expect(messages[0]).toEqual({ role: 'user', content: 'x' });
    // moonshot case 的采样默认值仍在（partial 注入不覆盖 vendor transform）
    expect(out.temperature).toBe(1.0);
    expect(out.top_p).toBe(0.95);
  });

  it('moonshot：正常请求（末条 user / tool）任何消息都不带 partial', () => {
    const cfg = { provider: 'moonshot', model: 'kimi-k2.6' } as ModelConfig;
    const transform = buildVendorCompatSettings(cfg).transformRequestBody!;
    const userLast = transform({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'x' }] });
    expect(JSON.stringify(userLast)).not.toContain('partial');
    // 历史里有 assistant 消息但末条是 tool：也不打标（防泄漏进正常多轮请求）
    const toolLast = transform({
      model: 'kimi-k2.6',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'old answer' },
        { role: 'tool', content: 'ok', tool_call_id: 'c1' },
      ],
    }) as Record<string, unknown>;
    expect(JSON.stringify(toolLast)).not.toContain('"partial"');
    // 采样默认值照常注入
    expect(toolLast.temperature).toBe(1.0);
  });

  it('非 prefix-param 档（xiaomi unknown）：transform 直通，不注入 prefix/partial', () => {
    const cfg = { provider: 'xiaomi', model: 'mimo-v2.5-pro' } as ModelConfig;
    const transform = buildVendorCompatSettings(cfg).transformRequestBody!;
    const out = JSON.parse(JSON.stringify(transform(resumeBody('mimo-v2.5-pro')))) as Record<string, unknown>;
    expect(out).not.toHaveProperty('prefix');
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[messages.length - 1]).not.toHaveProperty('partial');
  });
});

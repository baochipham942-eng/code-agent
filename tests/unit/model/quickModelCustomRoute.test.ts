// ============================================================================
// quick/memory/judge 车道 × 仅配置自定义 GLM provider（真 ConfigService + 真 secure storage，
// 本地 fake server 充当 open.bigmodel.cn；0ki 出站请求由 fetch 记录桩截获，不真出网）。
// ============================================================================
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Seen { host: string; auth: string }

const CUSTOM_ID = 'custom-glm-coding';
const CUSTOM_KEY = 'sk-custom-glm-secret';
const CUSTOM_MODEL = 'glm-5.3';

const warn = vi.fn();
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));

let tmp: string;
let server: http.Server;
let fakeHost: string;
let seen: Seen[];
const realFetch = globalThis.fetch;

const ENV_KEYS = [...new Set([...Object.keys(process.env).filter((k) => /_API_KEY$/.test(k)), 'ZHIPU_API_KEY'])];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  savedEnv.CODE_AGENT_DATA_DIR = process.env.CODE_AGENT_DATA_DIR;
  savedEnv.HOME = process.env.HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-custom-glm-'));
  process.env.CODE_AGENT_DATA_DIR = tmp;
  process.env.HOME = tmp;
  warn.mockClear();
  seen = [];
  server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host ?? '', auth: String(req.headers.authorization ?? '') });
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"worth":false,"isMeeting":false,"title":"t","worthKnowledge":[],"durableFacts":[]}' } }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fakeHost = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 非 fake server 的目的地（即 0ki 等）：只记录，不出网
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === fakeHost) return realFetch(input, init);
    const headers = new Headers(init?.headers);
    seen.push({ host: url.host, auth: headers.get('authorization') ?? '' });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  vi.resetModules();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.ZHIPU_API_KEY;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

async function setup(opts: {
  withCustom: boolean;
  /** 显式声明协议；缺省 = 不写字段（隐式 openai）。 */
  protocol?: 'openai' | 'claude' | 'responses';
  providerId?: string;
  model?: string;
}) {
  const { initConfigService } = await import('../../../src/host/services/core/configService');
  const { getSecureStorage } = await import('../../../src/host/services/core/secureStorage');
  const cfg = initConfigService();
  // vitest 的 electron 桩把 userData 指到整轮共享目录：先清掉上一个用例落盘的 config.json
  fs.rmSync((cfg as unknown as { configPath: string }).configPath, { force: true });
  await cfg.initialize();
  if (opts.withCustom) {
    const providerId = opts.providerId ?? CUSTOM_ID;
    getSecureStorage().setApiKey(providerId, CUSTOM_KEY);
    await cfg.updateSettings({
      models: {
        default: providerId,
        providers: {
          [providerId]: {
            enabled: true,
            baseUrl: `http://${fakeHost}/api/coding/paas/v4`,
            model: opts.model ?? CUSTOM_MODEL,
            displayName: 'GLM coding',
            ...(opts.protocol ? { protocol: opts.protocol } : {}),
          },
        },
      },
    } as never);
  }
  return import('../../../src/host/model/quickModel');
}

async function runLanes(qm: typeof import('../../../src/host/model/quickModel')) {
  const { judgeConversation } = await import('../../../src/host/lightMemory/conversationJudge');
  const quick = await qm.quickTask('hi', 16);
  const memory = await qm.memoryTask('hi', 16);
  const before = seen.length;
  await judgeConversation({ userMessages: ['hello world this is a long enough message'] });
  return { quick, memory, judgeRequests: seen.length - before };
}

describe('quick lanes × only custom GLM provider configured', () => {
  it('case1: 只有自定义 GLM provider → 三条车道都落到它的 endpoint，不碰 0ki', async () => {
    const qm = await setup({ withCustom: true });
    const { quick, memory, judgeRequests } = await runLanes(qm);
    expect(quick.provider).toBe(CUSTOM_ID);
    expect(memory.provider).toBe(CUSTOM_ID);
    expect(judgeRequests).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const s of seen) {
      expect(s.host).toBe(fakeHost);
      expect(s.host).not.toMatch(/0ki\.cn/);
      expect(s.auth).toBe(`Bearer ${CUSTOM_KEY}`);
    }
  });

  it('case2: 自定义 provider + 真 ZHIPU_API_KEY → 既有 zhipu/0ki 行为不变（routing.fast 仍在自定义之前）', async () => {
    process.env.ZHIPU_API_KEY = 'fake-zhipu';
    const qm = await setup({ withCustom: true });
    const quick = await qm.quickTask('hi', 16);
    expect(quick.provider).toBe('zhipu');
    expect(seen).toHaveLength(1);
    expect(seen[0].host).toMatch(/0ki\.cn$/);
    expect(seen[0].auth).toBe('Bearer fake-zhipu');
  });

  it('case2b: zhipu 被禁用但 env 有 ZHIPU_API_KEY → 自定义候选排在 0ki env 兜底之前', async () => {
    process.env.ZHIPU_API_KEY = 'fake-zhipu';
    const qm = await setup({ withCustom: true });
    const { getConfigService } = await import('../../../src/host/services/core/configService');
    await getConfigService().updateSettings({ models: { providers: { zhipu: { enabled: false }, longcat: { enabled: false } } } } as never);
    const quick = await qm.quickTask('hi', 16);
    expect(quick.provider).toBe(CUSTOM_ID);
    expect(seen.map((s) => s.host)).toEqual([fakeHost]);
  });

  it('case3: 什么都没配 → 不可用，warn 逐路由点名缺失项，不回落内置 zhipu 档', async () => {
    const qm = await setup({ withCustom: false });
    const quick = await qm.quickTask('hi', 16);
    const memory = await qm.memoryTask('hi', 16);
    expect(quick.failureReason).toBe('not_configured');
    expect(memory.failureReason).toBe('not_configured');
    expect(seen).toHaveLength(0);
    const msgs = warn.mock.calls.map((c) => JSON.stringify(c));
    expect(msgs.some((m) => /fast/.test(m) && /zhipu/.test(m) && /no key/i.test(m))).toBe(true);
    expect(msgs.some((m) => /code/.test(m) && /no key/i.test(m))).toBe(true);
  });

  it('case4: 自定义 provider 缺 endpoint / 被禁用 / key 被拉黑 → warn 分别点名', async () => {
    const qm = await setup({ withCustom: true });
    const { getConfigService } = await import('../../../src/host/services/core/configService');
    await getConfigService().updateSettings({ models: { providers: { [CUSTOM_ID]: { enabled: false } } } } as never);
    expect(await qm.quickTask('hi', 16)).toMatchObject({ failureReason: 'not_configured' });
    expect(warn.mock.calls.map((c) => JSON.stringify(c)).some((m) => m.includes(CUSTOM_ID) && /disabled/i.test(m))).toBe(true);
    warn.mockClear();
    await getConfigService().updateSettings({ models: { providers: { [CUSTOM_ID]: { enabled: true, baseUrl: '' } } } } as never);
    expect(await qm.quickTask('hi', 16)).toMatchObject({ failureReason: 'not_configured' });
    expect(warn.mock.calls.map((c) => JSON.stringify(c)).some((m) => m.includes(CUSTOM_ID) && /no endpoint/i.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 协议门（rework r1）：quick 车道只会说 OpenAI /chat/completions + Bearer。
// claude / responses 协议的默认中转不进本车道 —— 否则错格式请求会把主聊天还在用的
// key 拉黑并污染 quickModelAuthFailure 诊断。判定与主 loop 的协议改道同源。
// ---------------------------------------------------------------------------
describe('quick lanes × custom default provider protocol gate', () => {
  it('protocol=claude → 三条车道 not_configured、零出站请求、不拉黑 key，warn 点名协议', async () => {
    const qm = await setup({ withCustom: true, protocol: 'claude' });
    const { quick, memory, judgeRequests } = await runLanes(qm);
    expect(quick).toMatchObject({ failureReason: 'not_configured' });
    expect(memory).toMatchObject({ failureReason: 'not_configured' });
    expect(judgeRequests).toBe(0);
    expect(seen).toHaveLength(0);
    expect(qm.getQuickModelAuthFailure()).toBeNull();
    const msgs = warn.mock.calls.map((c) => JSON.stringify(c));
    expect(msgs.some((m) => m.includes(CUSTOM_ID) && /protocol 'claude'/.test(m) && /quick lane/i.test(m))).toBe(true);
  });

  it('protocol=responses → 同上，quiet not_configured 回落', async () => {
    const qm = await setup({ withCustom: true, protocol: 'responses' });
    const { quick, memory, judgeRequests } = await runLanes(qm);
    expect(quick).toMatchObject({ failureReason: 'not_configured' });
    expect(memory).toMatchObject({ failureReason: 'not_configured' });
    expect(judgeRequests).toBe(0);
    expect(seen).toHaveLength(0);
    expect(qm.getQuickModelAuthFailure()).toBeNull();
    const msgs = warn.mock.calls.map((c) => JSON.stringify(c));
    expect(msgs.some((m) => m.includes(CUSTOM_ID) && /protocol 'responses'/.test(m) && /quick lane/i.test(m))).toBe(true);
  });

  it('声明 openai 但能力矩阵按模型改道 Responses（custom-tokenrhythm/deepseek-v4-flash-0731）→ 同样拦下', async () => {
    const qm = await setup({
      withCustom: true,
      providerId: 'custom-tokenrhythm',
      model: 'deepseek-v4-flash-0731',
    });
    const { quick, memory, judgeRequests } = await runLanes(qm);
    expect(quick).toMatchObject({ failureReason: 'not_configured' });
    expect(memory).toMatchObject({ failureReason: 'not_configured' });
    expect(judgeRequests).toBe(0);
    expect(seen).toHaveLength(0);
    expect(qm.getQuickModelAuthFailure()).toBeNull();
    const msgs = warn.mock.calls.map((c) => JSON.stringify(c));
    expect(msgs.some((m) => m.includes('custom-tokenrhythm') && /protocol 'responses'/.test(m))).toBe(true);
  });

  it('显式声明 protocol=openai → 照常走自定义端点（门不过度拦截）', async () => {
    const qm = await setup({ withCustom: true, protocol: 'openai' });
    const { quick, memory, judgeRequests } = await runLanes(qm);
    expect(quick.provider).toBe(CUSTOM_ID);
    expect(memory.provider).toBe(CUSTOM_ID);
    expect(judgeRequests).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.host).toBe(fakeHost);
      expect(s.auth).toBe(`Bearer ${CUSTOM_KEY}`);
    }
  });
});

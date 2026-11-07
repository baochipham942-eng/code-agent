// ============================================================================
// quickModel × 出云密钥掩码（N-PROMPT-SECRET-MASK Rework r1）
// 快模型旁路（建议 / 归档判断）带会话原文，开关开时同样掩码出云、回包还原。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_MODELS } from '../../../src/shared/constants';

const { getConfigServiceMock } = vi.hoisted(() => ({ getConfigServiceMock: vi.fn() }));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => getConfigServiceMock(),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { quickTask, resetQuickModel } from '../../../src/host/model/quickModel';

const SECRET = 'sk-Abc123defGHI789xyz';
const PLACEHOLDER_RE = /\{\{SECRET_[A-Z_]+_[0-9a-f]{8}\}\}/;

function mockConfig(maskOn: boolean | undefined) {
  getConfigServiceMock.mockReturnValue({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({
      ...(maskOn === undefined ? {} : { privacy: { outboundSecretMask: maskOn } }),
      models: {
        providers: {},
        routing: {
          fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
          code: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
        },
      },
    }),
    getApiKey: (p: string) => (p === 'zhipu' ? 'zk' : undefined),
    getZhipuOfficialKey: () => 'zk',
  });
}

/** fetch mock：回包把请求里的占位符原样整段回显，模拟模型复述。 */
function mockEchoFetch() {
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
    const sent = JSON.parse(init.body).messages[0].content as string;
    const echoed = sent;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ choices: [{ message: { content: `reply:${echoed}` } }] }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetQuickModel();
  getConfigServiceMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('quickModel × outboundSecretMask', () => {
  it('开关开：请求体只见占位符，调用方拿到还原后的原值', async () => {
    mockConfig(true);
    const fetchMock = mockEchoFetch();
    const result = await quickTask(`检查 OPENAI_KEY=${SECRET} 是否合法`);
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(body).not.toContain(SECRET);
    expect(body).toMatch(PLACEHOLDER_RE);
    expect(result).toMatchObject({ success: true, content: `reply:检查 OPENAI_KEY=${SECRET} 是否合法` });
  });

  it('开关关 / 缺省：请求体字节不变（原文），回包不动', async () => {
    for (const flag of [false, undefined]) {
      resetQuickModel();
      mockConfig(flag);
      const fetchMock = mockEchoFetch();
      const result = await quickTask(`OPENAI_KEY=${SECRET}`);
      expect(fetchMock.mock.calls[0][1].body).toContain(SECRET);
      expect(result.content).toContain(SECRET);
    }
  });

  it('fail-closed：掩码抛错 → 不发请求，失败结果带可读提示', async () => {
    mockConfig(true);
    const fetchMock = mockEchoFetch();
    const mod = await import('../../../src/host/security/outboundSecretMask');
    const spy = vi.spyOn(mod, 'applyOutboundSecretMask').mockImplementation(() => {
      throw new Error('Outbound secret masking failed; Settings > Privacy');
    });
    try {
      const result = await quickTask(`OPENAI_KEY=${SECRET}`);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).toContain('Settings > Privacy');
    } finally {
      spy.mockRestore();
    }
  });
});

// ============================================================================
// imageModelHealth — 健康优先选型 + 单步兜底选择器（2a #3）
//
// 断言：
//  · 纯选择器 pickHealthyImageModelId / pickNextHealthyImageModelId 不读配置，逻辑确定；
//  · isImageModelConfigured / configuredImageModelIds 按 key 是否配置判定健康（mock key getters）。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/services/media/imageGenerationService', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/host/services/media/imageGenerationService')>();
  return {
    ...actual,
    getDashscopeApiKey: vi.fn(() => undefined),
    getZhipuOfficialApiKey: vi.fn(() => undefined),
    getGptImageConfig: vi.fn(() => undefined),
  };
});

vi.mock('../../../../src/host/services/core/configService', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/host/services/core/configService')>();
  return { ...actual, getConfigService: vi.fn(() => ({ getApiKey: vi.fn(() => undefined) })) };
});

import {
  pickHealthyImageModelId,
  pickNextHealthyImageModelId,
  isImageModelConfigured,
  configuredImageModelIds,
  isImageBalanceError,
  IMAGE_MODEL_HEALTH_PRIORITY,
} from '../../../../src/host/services/media/imageModelHealth';
import { IMAGE_MODELS } from '../../../../src/shared/constants/visualModels';
import * as svc from '../../../../src/host/services/media/imageGenerationService';
import * as cfgSvc from '../../../../src/host/services/core/configService';

const ALL = ['wanx-t2i', 'gpt-image-2', 'cogview-4', 'flux-2'];

// 每测前把所有 key getter 重置为「全未配」基线（mockReturnValue 不会被 clearAllMocks 重置，
// 否则前一个测试设的 sk-dash 会泄漏进下一个测试，污染 configuredImageModelIds）。
beforeEach(() => {
  vi.mocked(svc.getDashscopeApiKey).mockReturnValue(undefined);
  vi.mocked(svc.getZhipuOfficialApiKey).mockReturnValue(undefined);
  vi.mocked(svc.getGptImageConfig).mockReturnValue(undefined);
  vi.mocked(cfgSvc.getConfigService).mockReturnValue({ getApiKey: () => undefined } as never);
});

describe('isImageBalanceError（窄余额白名单，审计 MED-1）', () => {
  it('命中真·余额/欠费信号（中英 + DashScope/OpenAI 兼容）', () => {
    for (const m of [
      'InsufficientBalance: 余额不足',
      'insufficient_quota',
      'insufficient balance',
      '账户已欠费',
      'Account Arrearage',
      '余额为负',
      '402 Payment Required',
    ]) {
      expect(isImageBalanceError(m)).toBe(true);
    }
  });

  it('不误判非余额错误（裸 credit/billing/credential/quota exceeded 不触发额外付费）', () => {
    for (const m of [
      'credential error',
      'billing address invalid',
      '401 Unauthorized: invalid api key',
      'network error: ECONNRESET',
      'stream inactivity timeout',
      'model_not_allowed',
      'quota exceeded, retry later', // 速率限流措辞，非欠费——不该换模型多付费
      'request id 1402938 failed',   // \b402\b 不命中无关数字串
      'smearrears',                  // \barrear 前导边界挡掉非真实词
      '',
    ]) {
      expect(isImageBalanceError(m)).toBe(false);
    }
  });
});

describe('防漂移：健康优先级列表与 registry 对齐', () => {
  it('IMAGE_MODEL_HEALTH_PRIORITY 每个 id 都真实存在于 IMAGE_MODELS', () => {
    const registryIds = new Set(IMAGE_MODELS.map((m) => m.id));
    for (const id of IMAGE_MODEL_HEALTH_PRIORITY) {
      expect(registryIds.has(id)).toBe(true);
    }
  });

  it('覆盖全部内置生图模型（漏配会让某模型永远 unhealthy/不可兜底）', () => {
    expect([...IMAGE_MODEL_HEALTH_PRIORITY].sort()).toEqual(IMAGE_MODELS.map((m) => m.id).sort());
  });
});

describe('pickHealthyImageModelId（纯选择器）', () => {
  it('requested 命中且已配 → 用 requested', () => {
    expect(pickHealthyImageModelId('cogview-4', ['wanx-t2i', 'cogview-4'])).toBe('cogview-4');
  });

  it('requested 未配（不在 configured 列表）→ 退首个已配', () => {
    expect(pickHealthyImageModelId('flux-2', ['wanx-t2i', 'gpt-image-2'])).toBe('wanx-t2i');
  });

  it('requested 未知 id → 退首个已配', () => {
    expect(pickHealthyImageModelId('nope', ['gpt-image-2'])).toBe('gpt-image-2');
  });

  it('未指定 requested → 退首个已配（健康优先级顺序）', () => {
    expect(pickHealthyImageModelId(undefined, ['gpt-image-2', 'flux-2'])).toBe('gpt-image-2');
    expect(pickHealthyImageModelId(null, ['cogview-4'])).toBe('cogview-4');
  });

  it('一个都没配 → 回退静态 default(wanx-t2i)，保留"需要 key"原错路径', () => {
    expect(pickHealthyImageModelId(undefined, [])).toBe('wanx-t2i');
    expect(pickHealthyImageModelId('flux-2', [])).toBe('wanx-t2i');
  });
});

describe('pickNextHealthyImageModelId（单步兜底，不循环）', () => {
  it('返回 ≠ failedId 的下一个已配模型', () => {
    expect(pickNextHealthyImageModelId('wanx-t2i', ['wanx-t2i', 'gpt-image-2', 'cogview-4'])).toBe('gpt-image-2');
  });

  it('failedId 之外仍按健康优先级取首个（与 failedId 在列表中的位置无关）', () => {
    expect(pickNextHealthyImageModelId('cogview-4', ['wanx-t2i', 'cogview-4', 'flux-2'])).toBe('wanx-t2i');
  });

  it('只有 failedId 一个已配 → null（无可兜底，不循环）', () => {
    expect(pickNextHealthyImageModelId('wanx-t2i', ['wanx-t2i'])).toBeNull();
  });

  it('空 configured → null', () => {
    expect(pickNextHealthyImageModelId('wanx-t2i', [])).toBeNull();
  });
});

describe('isImageModelConfigured / configuredImageModelIds（读真实 key getter）', () => {
  it('全未配 → 全 false，configured 为空', () => {
    for (const id of ALL) expect(isImageModelConfigured(id)).toBe(false);
    expect(configuredImageModelIds()).toEqual([]);
  });

  it('配了 dashscope → 仅 wanx-t2i healthy', () => {
    vi.mocked(svc.getDashscopeApiKey).mockReturnValue('sk-dash');
    expect(isImageModelConfigured('wanx-t2i')).toBe(true);
    expect(isImageModelConfigured('cogview-4')).toBe(false);
    expect(configuredImageModelIds()).toEqual(['wanx-t2i']);
  });

  it('配了 zhipu + gptimage → cogview-4 与 gpt-image-2 healthy，按优先级排（gptimage 在 cogview 前）', () => {
    vi.mocked(svc.getZhipuOfficialApiKey).mockReturnValue('zk');
    vi.mocked(svc.getGptImageConfig).mockReturnValue({ base: 'https://x', key: 'k' });
    expect(configuredImageModelIds()).toEqual(['gpt-image-2', 'cogview-4']);
  });

  it('配了 openrouter（走 configService）→ flux-2 healthy', () => {
    vi.mocked(cfgSvc.getConfigService).mockReturnValue({ getApiKey: vi.fn((k: string) => (k === 'openrouter' ? 'or-key' : undefined)) } as never);
    expect(isImageModelConfigured('flux-2')).toBe(true);
    expect(configuredImageModelIds()).toEqual(['flux-2']);
  });

  it('未知 / custom id → false', () => {
    expect(isImageModelConfigured('sdxl-abc')).toBe(false);
    expect(isImageModelConfigured('openai-compat')).toBe(false);
  });
});

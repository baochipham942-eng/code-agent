import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCTOR_FIX_CODES } from '../../../src/shared/constants/doctor';

const quickModelState = vi.hoisted(() => ({
  failure: null as {
    provider: string;
    model: string;
    status: number;
    at: number;
  } | null,
}));

vi.mock('../../../src/host/model/quickModel', () => ({
  getQuickModelAuthFailure: () => quickModelState.failure,
}));

import { checkQuickModelAuth } from '../../../src/host/diagnostics/checks/quickModelAuth';

beforeEach(() => {
  quickModelState.failure = null;
});

describe('checkQuickModelAuth', () => {
  it('无鉴权失败记录时返回 skip', () => {
    expect(checkQuickModelAuth()).toEqual([
      expect.objectContaining({
        status: 'skip',
        message: '尚未发生快模型鉴权失败',
      }),
    ]);
  });

  it('有鉴权失败记录时返回 fail，并提供模型设置修复入口', () => {
    quickModelState.failure = {
      provider: 'zhipu',
      model: 'glm-4.5-flash',
      status: 403,
      at: Date.now(),
    };

    expect(checkQuickModelAuth()).toEqual([
      expect.objectContaining({
        status: 'fail',
        message: '快模型（zhipu / glm-4.5-flash）鉴权失败（HTTP 403），API Key 可能已失效或过期',
        fix: { code: DOCTOR_FIX_CODES.OPEN_PROVIDER_SETTINGS },
      }),
    ]);
  });
});

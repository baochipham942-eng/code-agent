import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCTOR_FIX_CODES } from '../../../src/shared/constants/doctor';

const quickModelState = vi.hoisted(() => ({
  failure: null as {
    provider: string;
    model: string;
    status: number;
    at: number;
  } | null,
  modelFailure: null as {
    provider?: string;
    model?: string;
    failureReason: 'invalid_response' | 'not_configured';
    status?: number;
    at: number;
  } | null,
}));

vi.mock('../../../src/host/model/quickModel', () => ({
  getQuickModelAuthFailure: () => quickModelState.failure,
  getQuickModelFailure: () => quickModelState.modelFailure,
}));

import { checkQuickModelAuth } from '../../../src/host/diagnostics/checks/quickModelAuth';

beforeEach(() => {
  quickModelState.failure = null;
  quickModelState.modelFailure = null;
});

describe('checkQuickModelAuth', () => {
  it('无鉴权失败记录时返回 skip', () => {
    expect(checkQuickModelAuth()).toEqual([
      expect.objectContaining({
        status: 'skip',
        message: '最近未检测到快模型失败',
      }),
    ]);
  });

  it('SSE/JSON 响应格式失败通过现有 Doctor provider_health 通道暴露', () => {
    quickModelState.modelFailure = {
      provider: 'custom-tokenrhythm',
      model: 'deepseek-v4-flash',
      failureReason: 'invalid_response',
      status: 200,
      at: Date.now(),
    };

    expect(checkQuickModelAuth()).toEqual([
      expect.objectContaining({
        status: 'fail',
        name: '快模型健康',
        message: '快模型（custom-tokenrhythm / deepseek-v4-flash）响应格式异常，HTTP 200，记忆判定或写回可能已降级',
        fix: { code: DOCTOR_FIX_CODES.OPEN_PROVIDER_SETTINGS },
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

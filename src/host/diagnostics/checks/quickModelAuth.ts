// ============================================================================
// Doctor Check - Quick Model Authentication
// 把最近一次快模型鉴权失败暴露给诊断页；成功请求后该记录会自动清除。
// ============================================================================

import { DOCTOR_FIX_CODES } from '../../../shared/constants/doctor';
import { getQuickModelAuthFailure, getQuickModelFailure } from '../../model/quickModel';
import type { DoctorItem } from '../types';

export function checkQuickModelAuth(): DoctorItem[] {
  const failure = getQuickModelAuthFailure();

  if (failure) {
    return [{
      category: 'provider_health',
      name: '快模型健康',
      status: 'fail',
      message: `快模型（${failure.provider} / ${failure.model}）鉴权失败（HTTP ${failure.status}），API Key 可能已失效或过期`,
      suggestion: '请前往模型设置更新对应 Provider 的 API Key',
      fix: { code: DOCTOR_FIX_CODES.OPEN_PROVIDER_SETTINGS },
    }];
  }

  const modelFailure = getQuickModelFailure();
  if (!modelFailure) {
    return [{
      category: 'provider_health',
      name: '快模型健康',
      status: 'skip',
      message: '最近未检测到快模型失败',
    }];
  }

  const modelLabel = modelFailure.provider && modelFailure.model
    ? `（${modelFailure.provider} / ${modelFailure.model}）`
    : '';
  const statusLabel = modelFailure.status ? `，HTTP ${modelFailure.status}` : '';
  const reasonLabel = modelFailure.failureReason === 'invalid_response'
    ? '响应格式异常'
    : `调用失败：${modelFailure.failureReason}`;
  return [{
    category: 'provider_health',
    name: '快模型健康',
    status: 'fail',
    message: `快模型${modelLabel}${reasonLabel}${statusLabel}，记忆判定或写回可能已降级`,
    suggestion: '请检查模型 Provider 的 endpoint、模型兼容性与服务状态后重试',
    fix: { code: DOCTOR_FIX_CODES.OPEN_PROVIDER_SETTINGS },
  }];
}

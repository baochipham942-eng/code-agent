// ============================================================================
// Doctor Check - Quick Model Authentication
// 把最近一次快模型鉴权失败暴露给诊断页；成功请求后该记录会自动清除。
// ============================================================================

import { DOCTOR_FIX_CODES } from '../../../shared/constants/doctor';
import { getQuickModelAuthFailure } from '../../model/quickModel';
import type { DoctorItem } from '../types';

export function checkQuickModelAuth(): DoctorItem[] {
  const failure = getQuickModelAuthFailure();

  if (!failure) {
    return [
      {
        category: 'provider_health',
        name: '快模型鉴权',
        status: 'skip',
        message: '尚未发生快模型鉴权失败',
      },
    ];
  }

  return [
    {
      category: 'provider_health',
      name: '快模型鉴权',
      status: 'fail',
      message: `快模型（${failure.provider} / ${failure.model}）鉴权失败（HTTP ${failure.status}），API Key 可能已失效或过期`,
      suggestion: '请前往模型设置更新对应 Provider 的 API Key',
      fix: { code: DOCTOR_FIX_CODES.OPEN_PROVIDER_SETTINGS },
    },
  ];
}

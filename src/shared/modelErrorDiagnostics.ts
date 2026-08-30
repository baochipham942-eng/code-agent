export type ModelErrorDiagnosticCode =
  | 'unsupported_temperature'
  | 'fallback_not_configured'
  | 'upstream_unavailable'
  | 'auth_failed'
  | 'quota_exhausted';

export interface ModelErrorDiagnostic {
  code: ModelErrorDiagnosticCode;
  message: string;
  suggestion: string;
  retryable: boolean;
  hasFallbackConfigurationIssue?: boolean;
}

function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ');
}

/** 从错误对象提取 HTTP status（AI SDK APICallError 用 statusCode，其余用 status） */
export function getModelErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const status = record['statusCode'] ?? record['status'];
  return typeof status === 'number' ? status : undefined;
}

export function classifyModelErrorMessage(message: string, statusCode?: number): ModelErrorDiagnostic | null {
  const normalized = normalizeMessage(message);
  const lower = normalized.toLowerCase();

  // 鉴权失败：401/403 或 key/认证类文案（含中文）。不可重试，必须换 key 或换模型。
  const authFailed =
    statusCode === 401
    || statusCode === 403
    || lower.includes('invalid_api_key')
    || lower.includes('invalid api key')
    || lower.includes('authentication_error')
    || lower.includes('failed to authenticate')
    || lower.includes('unauthorized')
    || lower.includes('鉴权失败')
    || lower.includes('api key 无效');
  if (authFailed) {
    return {
      code: 'auth_failed',
      message: '模型鉴权失败：API Key 无效、已过期或没有权限。',
      suggestion: '用 /login <provider> 重新配置 API Key，或用 /model 切换到其他可用模型。',
      retryable: false,
    };
  }

  // 欠费/配额耗尽：402、或余额/配额文案（429 只认配额文案形态，裸 429 限流不收）。
  // 不可重试——这类错误白等退避也不会好（2026-08-30 实测 longcat 欠费卡死 ~25s）。
  const quotaExhausted =
    statusCode === 402
    || lower.includes('insufficient_quota')
    || lower.includes('insufficient balance')
    || lower.includes('insufficient_balance')
    || lower.includes('account balance')
    || lower.includes('payment required')
    || lower.includes('欠费')
    || lower.includes('余额不足')
    || lower.includes('配额已用尽');
  if (quotaExhausted) {
    return {
      code: 'quota_exhausted',
      message: '模型账户余额或配额不足（欠费），请求被拒绝。',
      suggestion: '请充值或更换账户；也可以用 /model 切换到其他可用模型。',
      retryable: false,
    };
  }

  const unsupportedTemperature =
    lower.includes("unsupported value: 'temperature'")
    || lower.includes('unsupported value: "temperature"')
    || (/temperature/.test(lower) && /only the default\s*\(?1\)?\s+value is supported/.test(lower));
  const fallbackNotConfigured =
    lower.includes('no fallback model group found')
    || lower.includes('model group fallbacks=none')
    || lower.includes('fallbacks=none');

  if (unsupportedTemperature) {
    return {
      code: 'unsupported_temperature',
      message: fallbackNotConfigured
        ? '模型参数不兼容：当前模型只支持默认温度 1；同时中转没有为当前模型配置可用降级。'
        : '模型参数不兼容：当前模型只支持默认温度 1。',
      suggestion: fallbackNotConfigured
        ? '重试会使用默认温度 1；如果仍失败，请切换模型，或在中转侧补上当前模型的 fallback 映射。'
        : '重试会使用默认温度 1；如果仍失败，请切换到支持自定义温度的模型。',
      retryable: true,
      ...(fallbackNotConfigured ? { hasFallbackConfigurationIssue: true } : {}),
    };
  }

  // 网关/上游暂时不可用：只管 502/503/504 这一族。既匹配数字，也匹配 AI SDK 只给文案的形态
  // （实测 APICallError.message 就是 'Bad Gateway'，不含数字）。
  // ⚠️ 429 / too many requests **故意不收**：那一族有独立的配额语义（quota_exhausted），
  // 收进来会把「配额耗尽」误判成「网关抖动」，让用户以为重试就能好（2026-07-23 实测撞红）。
  const upstreamUnavailable =
    lower.includes('bad gateway')
    || lower.includes('service unavailable')
    || lower.includes('gateway timeout')
    || /\b(502|503|504)\b/.test(lower);

  if (upstreamUnavailable) {
    return {
      code: 'upstream_unavailable',
      message: '模型服务暂时不可用：上游网关没能把请求转过去（通常是服务方在抖动或限流）。',
      suggestion: '稍等几秒重试；持续失败就在输入框右下角换一个模型。',
      retryable: true,
    };
  }

  if (fallbackNotConfigured) {
    return {
      code: 'fallback_not_configured',
      message: '模型降级未配置：中转没有为当前模型配置可用 fallback。',
      suggestion: '请切换到已配置的模型，或在中转侧补上当前模型的 fallback 映射后重试。',
      retryable: false,
      hasFallbackConfigurationIssue: true,
    };
  }

  return null;
}

export function summarizeModelErrorForUser(message: string, statusCode?: number): string {
  const diagnostic = classifyModelErrorMessage(message, statusCode);
  if (diagnostic) {
    return `${diagnostic.message}\n建议：${diagnostic.suggestion}`;
  }

  const normalized = normalizeMessage(message);
  if (normalized.length <= 500) {
    return normalized;
  }
  return `${normalized.slice(0, 500)}...`;
}

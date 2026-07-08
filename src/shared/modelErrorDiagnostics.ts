export type ModelErrorDiagnosticCode =
  | 'unsupported_temperature'
  | 'fallback_not_configured';

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

export function classifyModelErrorMessage(message: string): ModelErrorDiagnostic | null {
  const normalized = normalizeMessage(message);
  const lower = normalized.toLowerCase();
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

export function summarizeModelErrorForUser(message: string): string {
  const diagnostic = classifyModelErrorMessage(message);
  if (diagnostic) {
    return `${diagnostic.message}\n建议：${diagnostic.suggestion}`;
  }

  const normalized = normalizeMessage(message);
  if (normalized.length <= 500) {
    return normalized;
  }
  return `${normalized.slice(0, 500)}...`;
}

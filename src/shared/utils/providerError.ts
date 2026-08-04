type ProviderErrorLike = {
  message?: unknown;
  error?: unknown;
  httpStatus?: unknown;
  statusCode?: unknown;
  status?: unknown;
};

export function getProviderErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as ProviderErrorLike;
  const status = value.httpStatus ?? value.statusCode ?? value.status;
  return typeof status === 'number' ? status : undefined;
}

export function getProviderErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const value = error as ProviderErrorLike;
  if (typeof value.message === 'string') return value.message;
  return typeof value.error === 'string' ? value.error : '';
}

/**
 * 供应商明确表达「需要充值」的统一判据。401 仍由调用方优先归入 auth：
 * mimo 曾用 401 Invalid API Key 表达额度耗尽，单凭这种响应无法精确区分 key 与余额。
 */
export function hasInsufficientBalanceSignal(error: unknown): boolean {
  if (getProviderErrorStatus(error) === 402) return true;
  const message = getProviderErrorMessage(error);
  return /payment required|insufficient[_\s-]*(?:balance|quota|credit)|(?:account\s+)?balance\s+(?:is\s+)?(?:insufficient|low|exhausted)|billing(?:\s+quota)?|余额不足|余额已?用尽|欠费|请充值/i.test(message);
}

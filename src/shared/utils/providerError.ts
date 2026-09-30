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

/** JSON fallback preview. Callers that persist the text may truncate again. */
const THROWN_ERROR_JSON_LIMIT = 2000;

function boundedThrownJson(value: object): string | undefined {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, nested: unknown) => {
      if (typeof nested === 'bigint') return nested.toString();
      if (typeof nested === 'object' && nested !== null) {
        if (seen.has(nested)) return '[Circular]';
        seen.add(nested);
      }
      return nested;
    });
    if (typeof json !== 'string' || json.length === 0) return undefined;
    if (json.length <= THROWN_ERROR_JSON_LIMIT) return json;
    return `${json.slice(0, THROWN_ERROR_JSON_LIMIT)}...`;
  } catch {
    return undefined;
  }
}

function stringWithoutObjectTag(error: unknown): string {
  try {
    const text = String(error);
    return text === '[object Object]' ? '{}' : text;
  } catch {
    return '{}';
  }
}

/**
 * Readable text for any thrown value.
 * Error → message (including empty); string → itself; object → non-empty
 * .message / .error string, else bounded JSON. A plain object never becomes
 * "[object Object]". Does not throw.
 */
export function formatThrownError(error: unknown): string {
  try {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error !== null && typeof error === 'object') {
      const structured = getProviderErrorMessage(error);
      if (structured.length > 0) return structured;
      const json = boundedThrownJson(error);
      if (json) return json;
    }
    return stringWithoutObjectTag(error);
  } catch {
    return stringWithoutObjectTag(error);
  }
}

/**
 * 供应商明确表达「需要充值」的统一判据。401 仍由调用方优先归入 auth：
 * mimo 曾用 401 Invalid API Key 表达额度耗尽，单凭这种响应无法精确区分 key 与余额。
 */
export function hasInsufficientBalanceSignal(error: unknown): boolean {
  if (getProviderErrorStatus(error) === 402) return true;
  const message = getProviderErrorMessage(error);
  return /payment required|insufficient[_\s-]*(?:balance|quota|credit)|(?:account\s+)?balance\s+(?:is\s+)?(?:too\s+)?(?:insufficient|low|exhausted)|run\s+out\s+of\s+credits?|exceed(?:ed|s|ing)?\s+(?:your\s+)?credit\s+limit|billing(?:\s+quota)?|余额不足|余额已?用尽|欠费|请充值/i.test(message);
}

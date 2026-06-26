export type ChannelErrorKind =
  | 'timeout'
  | 'permission'
  | 'model'
  | 'not_available'
  | 'cancelled'
  | 'unknown';

export interface ChannelErrorSummary {
  kind: ChannelErrorKind;
  message: string;
}

const TOKEN_PATTERN = /(sk-[a-z0-9_-]+|xox[baprs]-[a-z0-9-]+|Bearer\s+[a-z0-9._-]+)/i;
const STACK_PATTERN = /\bat\s+[\w$.<>]+\s*\(|\n\s*at\s+/;
const PATH_PATTERN = /\/(?:Users|var|tmp|private|Volumes)\/[^\s)]+/;

export function summarizeChannelError(error: unknown): ChannelErrorSummary {
  const raw = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String(error ?? '');
  const text = raw.toLowerCase();

  if (text.includes('abort') || text.includes('cancel')) {
    return { kind: 'cancelled', message: '处理已取消。' };
  }
  if (text.includes('timeout') || text.includes('timed out') || text.includes('超时')) {
    return { kind: 'timeout', message: '处理超时，请稍后重试。' };
  }
  if (
    text.includes('permission') ||
    text.includes('forbidden') ||
    text.includes('unauthorized') ||
    text.includes('not allowed') ||
    text.includes('权限')
  ) {
    return { kind: 'permission', message: '缺少必要权限，请在桌面端检查配置。' };
  }
  if (
    text.includes('agent not available') ||
    text.includes('account not connected') ||
    text.includes('channel not connected') ||
    text.includes('not connected')
  ) {
    return { kind: 'not_available', message: '通道暂时不可用，请稍后重试。' };
  }
  if (
    text.includes('model') ||
    text.includes('provider') ||
    text.includes('api') ||
    text.includes('rate limit') ||
    text.includes('429')
  ) {
    return { kind: 'model', message: '模型服务暂时不可用，请稍后重试。' };
  }

  return { kind: 'unknown', message: '处理失败，已记录本地日志。' };
}

export function isUnsafeChannelErrorText(value: string): boolean {
  return TOKEN_PATTERN.test(value) || STACK_PATTERN.test(value) || PATH_PATTERN.test(value);
}

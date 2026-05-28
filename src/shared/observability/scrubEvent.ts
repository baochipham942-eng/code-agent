// ============================================================================
// Sentry 事件脱敏 - renderer / node 两端共用的纯函数
// ============================================================================
//
// 红线：崩溃报告只允许携带堆栈 + 元数据，永远不能带用户源码 / prompt / 密钥 / 绝对路径。
// 本文件刻意不依赖任何 @sentry/* 包，用结构化最小类型描述要清洗的字段，
// 这样 renderer（浏览器）和 main（node）都能 import，不触发分层违规。
//
// ============================================================================

/** Sentry Event 中本模块会触碰的最小结构（避免给 shared 引入 sentry 依赖） */
export interface ScrubbableStackFrame {
  filename?: string;
  abs_path?: string;
}
export interface ScrubbableException {
  value?: string;
  stacktrace?: { frames?: ScrubbableStackFrame[] };
}
export interface ScrubbableEvent {
  message?: string;
  exception?: { values?: ScrubbableException[] };
  request?: { data?: unknown; cookies?: unknown };
  breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  user?: Record<string, unknown>;
}

export interface ScrubOptions {
  /** node 侧传 os.homedir()，把绝对路径里的家目录替换成 ~；renderer 留空 */
  homeDir?: string;
}

const REDACTED = '[REDACTED]';

// 常见密钥/令牌形态。命中即整体打码，宁可多打不可漏。
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, // OpenAI / Stripe 类
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi, // Authorization: Bearer xxx
  /\b(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"]?[A-Za-z0-9._\-/+]{8,}/gi, // key: value
  /\beyJ[A-Za-z0-9._-]{20,}/g, // JWT
];

const SENSITIVE_KEYS = /^(authorization|cookie|set-cookie|api[_-]?key|secret|token|password|passwd|prompt|userprompt|assistantresponse|completion|input|output|body|code|sourcecode|filecontent|filecontents)$/i;

/** 清洗单个字符串：先抹家目录绝对路径，再打码密钥形态 */
export function scrubString(input: string, opts: ScrubOptions = {}): string {
  let out = input;
  if (opts.homeDir && opts.homeDir.length > 1) {
    // 把 /Users/xxx 这类家目录前缀换成 ~，避免泄露用户名/磁盘布局
    out = out.split(opts.homeDir).join('~');
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

function scrubUnknown(value: unknown, opts: ScrubOptions, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubString(value, opts);
  if (!value || typeof value !== 'object') return value;

  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = scrubUnknown(value[i], opts, seen);
    }
    return value;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(key)) {
      (value as Record<string, unknown>)[key] = REDACTED;
      continue;
    }
    (value as Record<string, unknown>)[key] = scrubUnknown(child, opts, seen);
  }

  return value;
}

function scrubUser(user: Record<string, unknown>): void {
  for (const key of Object.keys(user)) {
    user[key] = REDACTED;
  }
}

/**
 * 就地清洗一个 Sentry Event：堆栈路径、异常消息、面包屑、message。
 * 同时丢弃可能夹带 payload 的 request.data / cookies。
 * 返回同一个对象（Sentry beforeSend 约定返回 event 或 null）。
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T, opts: ScrubOptions = {}): T {
  const seen = new WeakSet<object>();

  if (event.message) {
    event.message = scrubString(event.message, opts);
  }

  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubString(ex.value, opts);
    for (const frame of ex.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = scrubString(frame.filename, opts);
      if (frame.abs_path) frame.abs_path = scrubString(frame.abs_path, opts);
    }
  }

  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubString(crumb.message, opts);
    if (crumb.data) scrubUnknown(crumb.data, opts, seen);
  }

  if (event.extra) scrubUnknown(event.extra, opts, seen);
  if (event.contexts) scrubUnknown(event.contexts, opts, seen);
  if (event.tags) scrubUnknown(event.tags, opts, seen);
  if (event.user) scrubUser(event.user);

  // request body / cookies 可能夹带用户内容或会话凭证，直接丢弃
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
  }

  return event;
}

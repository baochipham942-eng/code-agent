// ============================================================================
// AppleScript helpers for native macOS office connectors
// ============================================================================

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../services/infra/logger';
import { getConfigService } from '../../services/core/configService';

const logger = createLogger('AppleScriptDate', { lane: 'mcp' });

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 1024 * 1024 * 10;
const DEFAULT_TIMEOUT = 15_000;

// TCC 拒绝 Apple Events 自动化时 osascript 以 errno -1743 退出（典型文案
// "Not authorized to send Apple events to Mail."）。匹配错误码或措辞把这类失败
// 归为「授权被拒」而不是一般读取失败（screenshotFailureCause / photos.ts 各有
// 私有同款判断，这里是可复用的一份）。
const APPLE_EVENTS_DENIED_PATTERN = /-1743|not authorized to send apple events/i;

/**
 * 判断错误是否为 Apple Events 授权被拒（-1743）。输入是 Error 时看 message，
 * 是字符串时直接匹配；其余一律 false。调用方用它把 read-error 细分成
 * not-authorized，渲染层才能给出「去设置」而不是永远重试。
 */
export function isAppleEventsDenied(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : '';
  return APPLE_EVENTS_DENIED_PATTERN.test(message);
}

export type AppleScriptFailureCode = 'not_authorized' | 'not_found' | 'timeout' | 'read_failed';

const APPLE_SCRIPT_NOT_FOUND_PATTERN = /-1728|can['’]t get/i;

function describeAppleScriptFailureText(
  english: boolean,
  label: string,
  code: AppleScriptFailureCode,
): string {
  if (english) {
    switch (code) {
      case 'not_authorized':
        return `${label} access was denied. Allow Neo under System Settings > Privacy & Security > Automation, then try again.`;
      case 'not_found':
        return `${label} could not find the requested mailbox, account or calendar. Check that the account exists in the ${label} app.`;
      case 'timeout':
        return `${label} did not respond in time. Please try again later.`;
      default:
        return `${label}: Read failed, please try again later`;
    }
  }
  switch (code) {
    case 'not_authorized':
      return `${label} 未获授权：请在「系统设置 > 隐私与安全性 > 自动化」中允许 Neo 控制 ${label}，然后重试。`;
    case 'not_found':
      return `${label} 找不到指定的邮箱/账户/日历：请在 ${label} 应用中检查对应账户是否存在。`;
    case 'timeout':
      return `${label} 响应超时，请稍后重试。`;
    default:
      return `${label}：读取失败，请稍后重试`;
  }
}

/**
 * 把 osascript 异常转成一句给用户/模型看的人话。execFile 的 error.message 以
 * "Command failed: osascript -e <整段脚本>" 开头，绝不能原样外露；这里只按错误码/信号分类，
 * 返回文案不含命令行、脚本或 stderr。原始异常由调用方写 host 日志。
 */
export function describeAppleScriptFailure(
  connectorLabel: string,
  error: unknown,
): { message: string; code: AppleScriptFailureCode } {
  const fields = (typeof error === 'object' && error !== null ? error : {}) as {
    killed?: unknown; signal?: unknown; code?: unknown; stderr?: unknown;
  };
  const text = [
    error instanceof Error ? error.message : typeof error === 'string' ? error : '',
    typeof fields.stderr === 'string' ? fields.stderr : '',
  ].join('\n');
  let code: AppleScriptFailureCode = 'read_failed';
  if (isAppleEventsDenied(text) || /not authorized/i.test(text)) code = 'not_authorized';
  else if (APPLE_SCRIPT_NOT_FOUND_PATTERN.test(text)) code = 'not_found';
  else if (fields.killed === true || fields.signal === 'SIGTERM' || fields.code === 'ETIMEDOUT') code = 'timeout';
  let english: boolean;
  try {
    english = getConfigService().getSettings().ui?.language === 'en';
  } catch {
    english = false;
  }
  return { message: describeAppleScriptFailureText(english, connectorLabel, code), code };
}

/**
 * 是否为 osascript/execFile 失败（而非连接器自己 throw 的参数/平台校验错误）。
 * 只有这类错误的 message 才会带整段脚本，才需要被改写成人话。
 */
export function isAppleScriptFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { message?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown; code?: unknown };
  return (typeof e.message === 'string' && e.message.startsWith('Command failed:'))
    || typeof e.stderr === 'string'
    || e.killed === true
    || (typeof e.signal === 'string' && e.signal !== '')
    || e.code === 'ETIMEDOUT';
}

/** 写 host 日志用的排查详情：stderr 优先；否则去掉开头的 "Command failed: osascript …" 命令行，截断 300 字。 */
export function appleScriptFailureLogDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim().slice(0, 300);
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split('\n');
  if (lines[0].startsWith('Command failed:')) {
    // 脚本以多个 -e 参数内联，命令行之后的最后几行是 osascript 的 stderr（取末 3 行，避开脚本正文）
    return lines.slice(1).slice(-3).join('\n').trim().slice(0, 300);
  }
  return message.slice(0, 300);
}

export async function runAppleScript(lines: string[]): Promise<string> {
  const args = lines.flatMap((line) => ['-e', line]);
  const { stdout } = await execFileAsync('osascript', args, {
    timeout: DEFAULT_TIMEOUT,
    maxBuffer: MAX_BUFFER,
  });
  return stdout.trim();
}

export function escapeAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

const ENGLISH_MONTHS: Record<string, number> = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

function to24Hour(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour;
  if (meridiem === '中午') return hour < 6 ? hour + 12 : hour;
  const pm = /^(PM|下午|晚上)$/i.test(meridiem);
  const h = hour % 12;
  return pm ? h + 12 : h;
}

function localTime(
  year: string, month0: number, day: string,
  hour: string, minute: string, second: string, meridiem?: string,
): number {
  return new Date(
    Number(year), month0, Number(day),
    to24Hour(Number(hour), meridiem), Number(minute), Number(second),
  ).getTime();
}

/**
 * 解析 AppleScript 输出的日期。顺序：ISO（isoDateText 产出，本地时间）→ 英文系统格式
 * → 中文系统格式。空串 = 字段本就缺省，静默 null；非空但解析失败 = warn 带原文再 null。
 */
export function parseAppleScriptDate(value: string): number | null {
  const text = value.trim();
  if (!text) return null;

  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (m) return localTime(m[1], Number(m[2]) - 1, m[3], m[4], m[5], m[6]);

  m = text.match(
    /^(?:[A-Za-z]+,\s+)?([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})(?:\s+at)?\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AP]M))?$/i
  );
  if (m) {
    const month = ENGLISH_MONTHS[m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()];
    if (month !== undefined) return localTime(m[3], month, m[2], m[4], m[5], m[6], m[7]);
  }

  m = text.match(
    /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(?:星期|周)[一二三四五六日天])?\s*(?:(上午|下午|凌晨|早上|中午|晚上)\s*)?(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AP]M))?$/i
  );
  if (m) return localTime(m[1], Number(m[2]) - 1, m[3], m[5], m[6], m[7], m[4] ?? m[8]);

  logger.warn('Unparseable AppleScript date, returning null', { raw: value });
  return null;
}

export function buildAppleScriptDateVar(varName: string, timestampMs: number): string[] {
  const date = new Date(timestampMs);
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  const midnightSeconds =
    (date.getHours() * 60 * 60)
    + (date.getMinutes() * 60)
    + date.getSeconds();

  return [
    `set ${varName} to current date`,
    `set year of ${varName} to ${date.getFullYear()}`,
    `set month of ${varName} to ${monthNames[date.getMonth()]}`,
    `set day of ${varName} to ${date.getDate()}`,
    `set time of ${varName} to ${midnightSeconds}`,
  ];
}

export function sharedAppleScriptHandlers(): string[] {
  return [
    'on sanitizeText(valueText)',
    'if valueText is missing value then return ""',
    'set safeText to valueText as text',
    'set {oldTID, AppleScript\'s text item delimiters} to {AppleScript\'s text item delimiters, {"|", return, linefeed, tab}}',
    'set safeText to (text items of safeText) as text',
    'set AppleScript\'s text item delimiters to " "',
    'set safeText to safeText as text',
    'set AppleScript\'s text item delimiters to oldTID',
    'return safeText',
    'end sanitizeText',
    'on joinLines(lineItems)',
    'set {oldTID, AppleScript\'s text item delimiters} to {AppleScript\'s text item delimiters, linefeed}',
    'set joinedText to lineItems as text',
    'set AppleScript\'s text item delimiters to oldTID',
    'return joinedText',
    'end joinLines',
    'on pad2(n)',
    'return text -2 thru -1 of ("0" & (n as integer))',
    'end pad2',
    'on isoDateText(d)',
    'if d is missing value then return ""',
    'set y to (year of d) as integer',
    'set yText to text -4 thru -1 of ("000" & y)',
    'return yText & "-" & my pad2((month of d) as integer) & "-" & my pad2(day of d) & "T" & my pad2(hours of d) & ":" & my pad2(minutes of d) & ":" & my pad2(seconds of d)',
    'end isoDateText',
  ];
}

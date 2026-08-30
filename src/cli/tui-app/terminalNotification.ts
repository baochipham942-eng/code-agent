// ============================================================================
// 终端通知（纯函数，无 Ink 依赖，可单测）
//
// turn 结束 / 审批卡出现 / 后台任务完成时发 OSC 9（iTerm2/WezTerm/kitty/ghostty/
// vscode），不支持的终端回退 BEL。失焦才发——语义对齐桌面端
// src/renderer/utils/osNotification.ts 的 shouldSuppressOsNotification
// （聚焦且可见时用户正盯着，通知只打扰不传信，抑制），终端侧的"可见"即焦点。
// NEO_DISABLE_TERMINAL_NOTIFY=1 为逃生门。
// ============================================================================

export interface TerminalNotifyEnv {
  TERM_PROGRAM?: string;
  TERM?: string;
  NEO_DISABLE_TERMINAL_NOTIFY?: string;
}

/** 焦点门控：终端聚焦 = 用户正盯着 → 抑制；失焦才发。 */
export function shouldTerminalNotify(focused: boolean): boolean {
  return !focused;
}

/** 当前终端是否支持 OSC 9 通知（不支持的终端对未知 OSC 静默忽略，回退 BEL） */
function supportsOsc9(env: TerminalNotifyEnv): boolean {
  const termProgram = env.TERM_PROGRAM ?? '';
  if (/^(iTerm\.app|WezTerm|ghostty|vscode)$/.test(termProgram)) return true;
  return /kitty/i.test(env.TERM ?? '');
}

/**
 * 构造通知字节序列。返回空串 = 不发（逃生门或空消息）。
 * 消息剥控制字符（防 OSC 注入）并截断，BEL 回退不含消息体。
 */
export function buildTerminalNotification(
  message: string,
  env: TerminalNotifyEnv,
): string {
  if (env.NEO_DISABLE_TERMINAL_NOTIFY === '1') return '';
  // eslint-disable-next-line no-control-regex -- 剥控制字符防 OSC 注入，必须匹配 \x00-\x1f
  const sanitized = message.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!sanitized) return '';
  return supportsOsc9(env) ? `\x1b]9;${sanitized}\x07` : '\x07';
}

/** 焦点上报（DECSET 1004）开关序列：Ink 挂载时开，卸载时关 */
export const FOCUS_REPORTING_ENABLE = '\x1b[?1004h';
export const FOCUS_REPORTING_DISABLE = '\x1b[?1004l';

/** stdin 里的焦点事件序列：\x1b[I = focus in，\x1b[O = focus out */
export function parseFocusEvent(chunk: string): 'in' | 'out' | null {
  if (chunk.includes('\x1b[I')) return 'in';
  if (chunk.includes('\x1b[O')) return 'out';
  return null;
}

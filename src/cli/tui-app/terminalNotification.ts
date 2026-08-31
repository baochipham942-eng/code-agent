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
/** Ghostty / iTerm 标签标题（OSC 0） */
export function formatTerminalTitle(input: {
  running: boolean;
  activity: string | null;
  queued: number;
  /** 会话标题；默认占位标题（尚未自动命名）不展示，回退产品名 */
  sessionTitle?: string | null;
}): string {
  const raw = input.sessionTitle?.trim() ?? '';
  const isDefault = !raw
    || raw.startsWith('CLI Session ')
    || raw === 'New Chat'
    || raw === '新对话';
  const title = isDefault ? 'neo' : raw;
  if (input.running) return `${input.activity ?? 'Working…'} · ${title}`;
  if (input.queued > 0) return `${title} · ${input.queued} queued`;
  return title;
}

export function buildTerminalTitleSequence(title: string): string {
  // eslint-disable-next-line no-control-regex -- 剥控制字符防 OSC 注入
  const sanitized = title.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `\x1b]0;${sanitized || 'neo'}\x07`;
}

export const FOCUS_REPORTING_ENABLE = '\x1b[?1004h';
export const FOCUS_REPORTING_DISABLE = '\x1b[?1004l';

/** stdin 里的焦点事件序列：\x1b[I = focus in，\x1b[O = focus out */
export function parseFocusEvent(chunk: string): 'in' | 'out' | null {
  if (chunk.includes('\x1b[I')) return 'in';
  if (chunk.includes('\x1b[O')) return 'out';
  return null;
}

/**
 * Ink use-input 对未识别的 CSI 序列会剥掉 ESC 前缀再上抛（ink use-input.js：
 * "Strip escape prefix from broken/incomplete sequences"）——焦点事件 \x1b[I/\x1b[O
 * 到达 useInput 时已变成 '[I'/'[O'，不过滤会被当文本插进草稿（截图/切窗时输入框
 * 出现 [O[I 乱码就是这么来的）。精确匹配整段输入：用户手敲 [ 和 I 是两次独立
 * 按键事件，不会整段等于 '[I'；代价是恰好 2 字符 '[I'/'[O' 的粘贴会被吃掉，可接受。
 */
export function isFocusEventInput(input: string): boolean {
  return input === '[I' || input === '[O';
}

/**
 * Ink 剥 ESC 后的 CSI 残片分类。整段匹配，避免手敲 '[' 被吃。
 * Ghostty/xterm modifyOtherKeys 的 Shift+Enter 是 `[27;2;13~`，不识别就会
 * 当文本插进草稿（截图像 `1111[27;2;13~`）。
 */
export type StrippedCsiKind = 'shift-enter' | 'drop';

export function classifyStrippedCsi(input: string): StrippedCsiKind | null {
  const s = input.startsWith('\x1b') ? input.slice(1) : input;
  // bracketed-paste 标记留给粘贴路径
  if (s === '[200~' || s === '[201~') return null;
  // modifyOtherKeys / kitty CSI-u：Shift(+Alt)+Enter
  if (
    s === '[27;2;13~' || s === '[27;2;10~'
    || s === '[27;4;13~' || s === '[27;4;10~'
    || s === '[13;2u' || s === '[10;2u'
    || s === '[13;4u' || s === '[10;4u'
  ) {
    return 'shift-enter';
  }
  if (/^\[(?:\d+(?:;\d+)*[~u]|<\d+;\d+;\d+[Mm])$/.test(s)) return 'drop';
  return null;
}

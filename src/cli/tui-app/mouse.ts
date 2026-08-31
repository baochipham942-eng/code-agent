// ============================================================================
// SGR 鼠标协议（DECSET 1006 + 1003 any-event）。纯函数，可单测。
// Ink 没有一等鼠标；Grok CLI（ratatui）首屏菜单可点，这里用同一套 CSI。
// ============================================================================

/** 任意移动 + SGR 坐标（1-based 列/行） */
export const MOUSE_SGR_ENABLE = '\x1b[?1003h\x1b[?1006h';
export const MOUSE_SGR_DISABLE = '\x1b[?1003l\x1b[?1006l';

export interface SgrMouseEvent {
  button: number;
  x: number;
  y: number;
  kind: 'press' | 'release' | 'move';
}

// eslint-disable-next-line no-control-regex -- SGR 鼠标序列以 ESC 开头
const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const STRIPPED_SGR_RE = /^\[<(\d+);(\d+);(\d+)([Mm])$/;

/** 从原始 stdin chunk 解析最后一次 SGR 事件 */
export function parseSgrMouse(chunk: string): SgrMouseEvent | null {
  let last: SgrMouseEvent | null = null;
  SGR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_RE.exec(chunk)) !== null) {
    last = decodeSgr(match[1], match[2], match[3], match[4]);
  }
  return last;
}

/** Ink useInput 会剥掉 ESC，焦点/鼠标序列变成 `[<0;1;1M` */
export function isMouseEventInput(input: string): boolean {
  return STRIPPED_SGR_RE.test(input);
}

function decodeSgr(buttonRaw: string, xRaw: string, yRaw: string, flag: string): SgrMouseEvent {
  const code = Number(buttonRaw);
  const motion = (code & 32) !== 0;
  const button = code & 3;
  const kind = motion ? 'move' : flag === 'm' ? 'release' : 'press';
  return { button, x: Number(xRaw), y: Number(yRaw), kind };
}

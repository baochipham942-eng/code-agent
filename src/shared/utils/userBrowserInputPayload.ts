// 用户画面交互透传 payload 校验（浏览器三期 P1 / R4 drag）。
// 只接受白名单 kind + 有界坐标/滚轮/按键/拖拽；禁止任意 CDP 方法字段。

import { BROWSER_STAGE_VIEWPORT } from '../constants';

type UserBrowserInputKind = 'click' | 'wheel' | 'key' | 'insertText' | 'drag';

interface UserBrowserClickInput {
  kind: 'click';
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
}

interface UserBrowserWheelInput {
  kind: 'wheel';
  deltaX: number;
  deltaY: number;
  x?: number;
  y?: number;
}

interface UserBrowserKeyInput {
  kind: 'key';
  key: string;
  code?: string;
  modifiers?: {
    alt?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
  };
}

interface UserBrowserInsertTextInput {
  kind: 'insertText';
  text: string;
}

/** 拖拽：起点 → 可选中间点 → 终点（host 走 mouse.down/move/up） */
interface UserBrowserDragInput {
  kind: 'drag';
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** 中间路径点（有界）；缺省时 host 可线性插值 */
  path?: Array<{ x: number; y: number }>;
  button?: 'left' | 'right' | 'middle';
}

export type UserBrowserInputPayload =
  | UserBrowserClickInput
  | UserBrowserWheelInput
  | UserBrowserKeyInput
  | UserBrowserInsertTextInput
  | UserBrowserDragInput;

export interface ValidateUserBrowserInputOptions {
  /** 视口宽（CSS px）；缺省时仍校验有限且非负 */
  viewportWidth?: number;
  /** 视口高（CSS px） */
  viewportHeight?: number;
}

const MAX_COORD = 16_384;
const MAX_DELTA = 32_768;
const MAX_CLICK_COUNT = 3;
const MAX_KEY_LEN = 32;
const MAX_TEXT_LEN = 2_048;

/** 允许的单键名（Playwright keyboard.press 友好集合 + 常见导航键） */
const KEY_PATTERN = /^[A-Za-z0-9]$|^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space| )$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function rejectCdpPassthrough(raw: Record<string, unknown>): string | null {
  // 结构红线：禁止携带任意 CDP 方法名 / raw params 透传字段
  const forbiddenKeys = [
    'cdpMethod', 'cdp', 'method', 'params', 'session', 'protocol',
    'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  ];
  for (const key of forbiddenKeys) {
    if (key in raw) {
      return `Forbidden field in user browser input: ${key}`;
    }
  }
  return null;
}

function clampCoord(value: number, max?: number): boolean {
  if (value < 0 || value > MAX_COORD) return false;
  if (typeof max === 'number' && Number.isFinite(max) && max > 0 && value > max) return false;
  return true;
}

/**
 * 校验并规范化用户画面输入。失败返回 error 字符串（供 host 拒收 / 单测断言）。
 */
export function validateUserBrowserInputPayload(
  raw: unknown,
  options: ValidateUserBrowserInputOptions = {},
): { ok: true; payload: UserBrowserInputPayload } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: 'User browser input must be an object.' };
  }
  const cdpError = rejectCdpPassthrough(raw);
  if (cdpError) return { ok: false, error: cdpError };

  const kind = raw.kind;
  if (
    kind !== 'click'
    && kind !== 'wheel'
    && kind !== 'key'
    && kind !== 'insertText'
    && kind !== 'drag'
  ) {
    return { ok: false, error: `Unsupported user browser input kind: ${String(kind)}` };
  }

  if (kind === 'click') {
    const x = finiteNumber(raw.x);
    const y = finiteNumber(raw.y);
    if (x === null || y === null) {
      return { ok: false, error: 'Click requires finite x/y coordinates.' };
    }
    if (!clampCoord(x, options.viewportWidth) || !clampCoord(y, options.viewportHeight)) {
      return { ok: false, error: 'Click coordinates out of bounds.' };
    }
    const button = raw.button === undefined
      ? 'left'
      : raw.button === 'left' || raw.button === 'right' || raw.button === 'middle'
        ? raw.button
        : null;
    if (!button) return { ok: false, error: 'Invalid click button.' };
    const clickCountRaw = raw.clickCount === undefined ? 1 : finiteNumber(raw.clickCount);
    if (clickCountRaw === null || clickCountRaw < 1 || clickCountRaw > MAX_CLICK_COUNT || !Number.isInteger(clickCountRaw)) {
      return { ok: false, error: 'Invalid clickCount.' };
    }
    return {
      ok: true,
      payload: {
        kind: 'click',
        x,
        y,
        button,
        clickCount: clickCountRaw,
      },
    };
  }

  if (kind === 'wheel') {
    const deltaX = finiteNumber(raw.deltaX);
    const deltaY = finiteNumber(raw.deltaY);
    if (deltaX === null || deltaY === null) {
      return { ok: false, error: 'Wheel requires finite deltaX/deltaY.' };
    }
    if (Math.abs(deltaX) > MAX_DELTA || Math.abs(deltaY) > MAX_DELTA) {
      return { ok: false, error: 'Wheel delta out of bounds.' };
    }
    const payload: UserBrowserWheelInput = { kind: 'wheel', deltaX, deltaY };
    if (raw.x !== undefined || raw.y !== undefined) {
      const x = finiteNumber(raw.x);
      const y = finiteNumber(raw.y);
      if (x === null || y === null) {
        return { ok: false, error: 'Wheel x/y must be finite when provided.' };
      }
      if (!clampCoord(x, options.viewportWidth) || !clampCoord(y, options.viewportHeight)) {
        return { ok: false, error: 'Wheel coordinates out of bounds.' };
      }
      payload.x = x;
      payload.y = y;
    }
    return { ok: true, payload };
  }

  if (kind === 'key') {
    const key = typeof raw.key === 'string' ? raw.key : '';
    if (!key || key.length > MAX_KEY_LEN || !KEY_PATTERN.test(key)) {
      return { ok: false, error: 'Invalid or unsupported key.' };
    }
    const code = typeof raw.code === 'string' && raw.code.length > 0 && raw.code.length <= MAX_KEY_LEN
      ? raw.code
      : undefined;
    const mods = isRecord(raw.modifiers) ? raw.modifiers : undefined;
    const payload: UserBrowserKeyInput = { kind: 'key', key };
    if (code) payload.code = code;
    if (mods) {
      payload.modifiers = {
        alt: mods.alt === true,
        ctrl: mods.ctrl === true,
        meta: mods.meta === true,
        shift: mods.shift === true,
      };
    }
    return { ok: true, payload };
  }

  if (kind === 'drag') {
    const fromX = finiteNumber(raw.fromX);
    const fromY = finiteNumber(raw.fromY);
    const toX = finiteNumber(raw.toX);
    const toY = finiteNumber(raw.toY);
    if (fromX === null || fromY === null || toX === null || toY === null) {
      return { ok: false, error: 'Drag requires finite fromX/fromY/toX/toY.' };
    }
    if (
      !clampCoord(fromX, options.viewportWidth)
      || !clampCoord(fromY, options.viewportHeight)
      || !clampCoord(toX, options.viewportWidth)
      || !clampCoord(toY, options.viewportHeight)
    ) {
      return { ok: false, error: 'Drag coordinates out of bounds.' };
    }
    const button = raw.button === undefined
      ? 'left'
      : raw.button === 'left' || raw.button === 'right' || raw.button === 'middle'
        ? raw.button
        : null;
    if (!button) return { ok: false, error: 'Invalid drag button.' };

    let path: Array<{ x: number; y: number }> | undefined;
    if (raw.path !== undefined) {
      if (!Array.isArray(raw.path)) {
        return { ok: false, error: 'Drag path must be an array of points.' };
      }
      if (raw.path.length > BROWSER_STAGE_VIEWPORT.DRAG_PATH_MAX_POINTS) {
        return { ok: false, error: 'Drag path too long.' };
      }
      path = [];
      for (const point of raw.path) {
        if (!isRecord(point)) {
          return { ok: false, error: 'Drag path points must be objects.' };
        }
        const x = finiteNumber(point.x);
        const y = finiteNumber(point.y);
        if (x === null || y === null) {
          return { ok: false, error: 'Drag path points require finite x/y.' };
        }
        if (!clampCoord(x, options.viewportWidth) || !clampCoord(y, options.viewportHeight)) {
          return { ok: false, error: 'Drag path coordinates out of bounds.' };
        }
        path.push({ x, y });
      }
    }

    return {
      ok: true,
      payload: {
        kind: 'drag',
        fromX,
        fromY,
        toX,
        toY,
        button,
        ...(path ? { path } : {}),
      },
    };
  }

  // insertText
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!text || text.length > MAX_TEXT_LEN) {
    return { ok: false, error: 'insertText requires non-empty text within length limit.' };
  }
  // 拒绝控制字符（保留换行/制表）；不用 control-char class 写法以避开 no-control-regex
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return { ok: false, error: 'insertText contains forbidden control characters.' };
    }
  }
  return { ok: true, payload: { kind: 'insertText', text } };
}

/**
 * 结构断言：payload 类型上不得携带任意 CDP 直通字段（单测用）。
 */
export function assertNoCdpPassthroughShape(payload: UserBrowserInputPayload): void {
  const keys = Object.keys(payload as unknown as Record<string, unknown>);
  for (const key of keys) {
    if (key === 'cdpMethod' || key === 'method' || key === 'params' || key.startsWith('Input.')) {
      throw new Error(`CDP passthrough field leaked: ${key}`);
    }
  }
  if (!('kind' in payload)) {
    throw new Error('User browser input missing kind discriminator.');
  }
}

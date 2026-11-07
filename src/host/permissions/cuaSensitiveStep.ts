// ============================================================================
// cua-driver 敏感步骤交回（ADR-088 方案 B · 一期 FU2：密码框输入）
// 规格唯一真源：docs/architecture/sensitive-step-handback.md。
//
// 窗口级规则：目标窗口最新快照含 AXSecureTextField（结构性信号，索引行与未索引行都算，
// 信号在 cuaNarration 的快照缓存里维护）→ type_text / set_value / type_text_chars，
// 以及可产出字符的 press_key（单字符，仅可选 shift）和粘贴 hotkey（cmd/ctrl + v）
// 不执行、不吃任何已记住的应用授权（resolvePreAskGrant blocked），改弹 forceConfirm
// 交回卡；导航/控制键与非粘贴组合键保留原按应用审批链。该窗口无任何快照 = 无信号 →
// 不升格交回，照旧走按应用审批链并打 debug 留痕（规格 §8/§9）。
// 二期 FU3（支付/验证码词表）只会往 SENSITIVE_INPUT_CUA_TOOLS/词表侧加信号源，接同一道门。
// ============================================================================

import type { ComputerTargetApp } from './computerAppTarget';
import type { PermissionRequestData } from '../tools/types';
import { PermissionRequestReason } from '../../shared/contract/permission';
import { readCuaClickTargets, readCuaWindowSecureField } from '../mcp/cuaNarration';
import { CUA_SENSITIVE_BUTTON_WORDS, type CuaSensitiveButtonKind } from '../../shared/constants';
import { parseCuaToolName } from './cuaAppTarget';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CuaSensitiveStep');

/** 一期覆盖的文本输入工具；type_text_chars 是驱动 invoke 期别名（不进 tools/list，mod.rs:698-706）。 */
const SENSITIVE_INPUT_CUA_TOOLS = new Set(['type_text', 'set_value', 'type_text_chars']);

/** 二期点击类工具（element_index 路径 + 像素窗口级兜底）。 */
const SENSITIVE_CLICK_CUA_TOOLS = new Set(['click', 'double_click', 'right_click']);

const escapeRegExp = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 词表编译一次：cjk 子串 + latin 单词边界（repay / payload 不命中），大小写不敏感。 */
const SENSITIVE_BUTTON_MATCHERS = CUA_SENSITIVE_BUTTON_WORDS.map(({ kind, cjk, latin }) => ({
  kind,
  re: new RegExp(
    [
      ...cjk.map(escapeRegExp),
      ...latin.map((w) => `(?<![A-Za-z0-9])${escapeRegExp(w)}(?![A-Za-z0-9])`),
    ].join('|'),
    'i',
  ),
}));

function matchSensitiveButtonKind(label: string): CuaSensitiveButtonKind | null {
  for (const { kind, re } of SENSITIVE_BUTTON_MATCHERS) {
    if (re.test(label)) return kind;
  }
  return null;
}

/** hotkey 粘贴主修饰键（macOS cmd / 跨平台 ctrl 及其常见别名，大小写不敏感）。 */
const PASTE_PRIMARY_MODIFIERS = new Set(['cmd', 'command', 'ctrl', 'control', 'meta', 'super']);
const ALL_HOTKEY_MODIFIERS = new Set([
  ...PASTE_PRIMARY_MODIFIERS,
  'shift',
  'alt',
  'option',
  'opt',
  'fn',
]);

function isSinglePrintableChar(value: string): boolean {
  const chars = Array.from(value);
  return chars.length === 1 && !/\p{C}/u.test(chars[0]);
}

function isShiftOnlyModifiers(modifiers: unknown): boolean {
  if (modifiers === undefined || modifiers === null) return true;
  if (!Array.isArray(modifiers)) return false;
  return modifiers.every((m) => typeof m === 'string' && m.toLowerCase() === 'shift');
}

/**
 * press_key 仅交回会打出字符的按键（单个可打印字符，只允许无修饰键或单独 shift）。
 * Return/Tab/Escape/方向键/Delete 及带 cmd/ctrl/alt 的快捷键保留原按应用审批链，
 * 避免用户输完密码后模型按 Return 提交时二次弹交回卡。
 */
function isCharacterProducingPressKey(params: Record<string, unknown> | null | undefined): boolean {
  const key = params?.key;
  if (typeof key !== 'string' || key.length === 0) return false;
  if (!isShiftOnlyModifiers(params?.modifiers)) return false;
  if (isSinglePrintableChar(key)) return true;
  const shiftChord = /^shift\+(.+)$/is.exec(key);
  return shiftChord !== null && isSinglePrintableChar(shiftChord[1]);
}

/** hotkey 仅交回粘贴组合键（cmd/ctrl + v，含 cmd+shift+v 等无样式粘贴变体，大小写不敏感）。 */
function isPasteHotkey(params: Record<string, unknown> | null | undefined): boolean {
  const rawKeys = params?.keys;
  const items: unknown[] = Array.isArray(rawKeys)
    ? rawKeys
    : typeof rawKeys === 'string'
      ? [rawKeys]
      : [];
  if (items.length === 0) return false;
  const tokens: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') return false;
    const parts = item.length > 1 && item.includes('+') ? item.split('+') : [item];
    for (const part of parts) {
      const normalized = part.trim().toLowerCase();
      if (!normalized) return false;
      tokens.push(normalized);
    }
  }
  let hasPrimary = false;
  const nonModifiers: string[] = [];
  for (const token of tokens) {
    if (PASTE_PRIMARY_MODIFIERS.has(token)) {
      hasPrimary = true;
    } else if (!ALL_HOTKEY_MODIFIERS.has(token)) {
      nonModifiers.push(token);
    }
  }
  return hasPrimary && nonModifiers.length === 1 && nonModifiers[0] === 'v';
}

function isSensitiveCandidateCuaCall(
  bareTool: string,
  params: Record<string, unknown> | null | undefined,
): boolean {
  if (SENSITIVE_INPUT_CUA_TOOLS.has(bareTool)) return true;
  if (bareTool === 'press_key') return isCharacterProducingPressKey(params);
  if (bareTool === 'hotkey') return isPasteHotkey(params);
  return false;
}

export interface CuaSensitiveStep {
  kind: 'password' | CuaSensitiveButtonKind;
  /** 目标 secure 字段的 label（公开界面元数据，非秘密本体），供交回卡与回话模板点名。 */
  elementLabel?: string;
}

/**
 * 分类一次 cua 调用是否命中敏感步骤交回。判定必须早于 resolvePreAskGrant 消费
 * （toolExecutor pre-ask 点）——已记住的应用授权压不掉交回卡（规格 §2 判定顺序）。
 */
export function classifyCuaSensitiveStep(
  executionToolName: string,
  params: Record<string, unknown> | null | undefined,
): CuaSensitiveStep | null {
  const tool = parseCuaToolName(executionToolName);
  if (tool !== null && SENSITIVE_CLICK_CUA_TOOLS.has(tool)) return classifyClick(executionToolName, params ?? {});
  if (tool === null || !isSensitiveCandidateCuaCall(tool, params)) return null;
  const signal = readCuaWindowSecureField(params ?? {});
  if (signal === null) {
    // 无信号不升格是有意取舍（规格 §9：无差别交回全部输入 = 卡片通胀）；但缺口要留痕可查。
    logger.debug('cua sensitive step: no window snapshot cached, no signal (gap)', {
      tool: executionToolName,
      pid: typeof params?.pid === 'number' ? params.pid : undefined,
      windowId: typeof params?.window_id === 'number' ? params.window_id : undefined,
    });
    return null;
  }
  if (!signal.secure) return null;
  return { kind: 'password', ...(signal.label ? { elementLabel: signal.label } : {}) };
}

/** 点击类：element_index 先 join 目标 label；像素点击退到窗口里是否有命中词表的可点击元素。 */
function classifyClick(executionToolName: string, params: Record<string, unknown>): CuaSensitiveStep | null {
  const snapshot = readCuaClickTargets(params);
  if (snapshot === null) {
    logger.debug('cua sensitive click: no window snapshot cached, no signal (gap)', {
      tool: executionToolName,
      pid: typeof params.pid === 'number' ? params.pid : undefined,
      windowId: typeof params.window_id === 'number' ? params.window_id : undefined,
    });
    return null;
  }
  if (typeof params.element_index === 'number') {
    const label = snapshot.target?.label;
    if (!label) return null; // 索引未命中缓存 / 无 label（图标按钮）：已知缺口，规格 §8
    const kind = matchSensitiveButtonKind(label);
    return kind ? { kind, elementLabel: label } : null;
  }
  if (typeof params.x !== 'number' || typeof params.y !== 'number') return null;
  for (const el of snapshot.clickables) {
    const kind = matchSensitiveButtonKind(el.label);
    if (kind) return { kind, elementLabel: el.label };
  }
  return null;
}

/**
 * 被键入的文本 / 字段值 / 按键绝不进任何载荷（规格 §3：请求、指纹输入、台账、卡片全算）。
 * 这一步永不执行，参数本体没有留存价值——一律浅拷贝剥掉。
 */
export function stripSensitiveStepParams(params: Record<string, unknown>): Record<string, unknown> {
  const { text: _text, value: _value, key: _key, keys: _keys, modifiers: _modifiers, ...rest } = params;
  return rest;
}

/**
 * 把既有权限请求改写成交回卡形状（规格 §4）：forceConfirm 隐藏一切「记住」选项；
 * details 整体替换——只带 kind/elementLabel/appName 与裸工具名，不带 targetApp/text/value。
 * appName 是展示用元数据（交回卡 {app} 变量），不是 targetApp——授权铸造只认 targetApp。
 */
export function decorateSensitiveStepRequest(
  request: PermissionRequestData,
  step: CuaSensitiveStep,
  targetApp: ComputerTargetApp | null,
  executionToolName: string,
): void {
  request.type = 'dangerous_command'; // 与 captcha gate 同型；不带 dangerLevel——流程性交回，不是危险红卡
  request.forceConfirm = true;
  delete request.dangerLevel;
  delete request.forceConfirmBoundaryOnly; // 交回不是 W3 写边界形态，boundary-only 标记无意义
  request.reasonCode = PermissionRequestReason.SensitiveStepHandback;
  request.reason = '这一步请你亲手完成';
  const bareTool = parseCuaToolName(executionToolName);
  request.details = {
    sensitiveStep: {
      kind: step.kind,
      ...(step.elementLabel ? { elementLabel: step.elementLabel } : {}),
      ...(targetApp?.name ? { appName: targetApp.name } : {}),
    },
    ...(bareTool ? { action: bareTool } : {}),
  };
}

/**
 * 交回的工具回话（规格 §5）。两个出口都是 success:true——工具调用正确履行了它的契约
 * （交回 + 如实汇报），不把用户的选择记成工具失败；模板都必须明说这一步不是 Neo 执行的。
 */
export function sensitiveStepHandbackResolution(
  step: CuaSensitiveStep,
  outcome: 'done_by_user' | 'skipped',
  options?: { expiredUnanswered?: boolean },
): { result: string; metadata: { code: 'SENSITIVE_STEP_HANDBACK'; outcome: 'done_by_user' | 'skipped' } } {
  const label = step.elementLabel ?? 'sensitive field';
  if (outcome === 'done_by_user') {
    return {
      result: `SENSITIVE_STEP_DONE_BY_USER — I did NOT perform this step. The user completed "${label}" (${step.kind}) by hand and pressed continue. Re-read the window with get_window_state before acting again, then continue the task. Do not attempt this step yourself.`,
      metadata: { code: 'SENSITIVE_STEP_HANDBACK', outcome },
    };
  }
  const expiryLine = options?.expiredUnanswered
    ? '\nThe hand-back expired unanswered (parked approval backstop), so it counts as skipped.'
    : '';
  return {
    result: `SENSITIVE_STEP_SKIPPED_BY_USER — I did NOT perform this step. The user chose to skip "${label}" (${step.kind}). Continue the rest of the task without it, or ask the user how to proceed. Do not retry this step.${expiryLine}`,
    metadata: { code: 'SENSITIVE_STEP_HANDBACK', outcome },
  };
}

// ============================================================================
// cua-driver 敏感步骤交回（ADR-088 方案 B · 一期 FU2：密码框输入）
// 规格唯一真源：docs/architecture/sensitive-step-handback.md。
//
// 窗口级规则：目标窗口最新快照含 AXSecureTextField（结构性信号，索引行与未索引行都算，
// 信号在 cuaNarration 的快照缓存里维护）→ type_text / set_value / type_text_chars
// 不执行、不吃任何已记住的应用授权（resolvePreAskGrant blocked），改弹 forceConfirm
// 交回卡。该窗口无任何快照 = 无信号 → 不升格交回，照旧走按应用审批链（规格 §9）。
// 二期 FU3（支付/验证码词表）只会往 SENSITIVE_INPUT_CUA_TOOLS/词表侧加信号源，接同一道门。
// ============================================================================

import type { ComputerTargetApp } from './computerAppTarget';
import type { PermissionRequestData } from '../tools/types';
import { PermissionRequestReason } from '../../shared/contract/permission';
import { readCuaWindowSecureField } from '../mcp/cuaNarration';
import { parseCuaToolName } from './cuaAppTarget';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CuaSensitiveStep');

/** 一期覆盖的输入类工具；type_text_chars 是驱动 invoke 期别名（不进 tools/list，mod.rs:698-706）。 */
const SENSITIVE_INPUT_CUA_TOOLS = new Set(['type_text', 'set_value', 'type_text_chars']);

export interface CuaSensitiveStep {
  kind: 'password';
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
  if (tool === null || !SENSITIVE_INPUT_CUA_TOOLS.has(tool)) return null;
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

/**
 * 被键入的文本 / 字段值绝不进任何载荷（规格 §3：请求、指纹输入、台账、卡片全算）。
 * 这一步永不执行，参数本体没有留存价值——一律浅拷贝剥掉。
 */
export function stripSensitiveStepParams(params: Record<string, unknown>): Record<string, unknown> {
  const { text: _text, value: _value, ...rest } = params;
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

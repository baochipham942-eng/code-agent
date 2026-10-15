// ============================================================================
// skillCautionPrompt - 聊天面 skill caution 确认面（外部 store + 安装驱动）
// ============================================================================
// 拖拽 ZIP / /plugins install 这些入口不在设置页里，没有自己的确认弹窗：host 侧
// caution 门回 SKILL_CAUTION_CONFIRMATION_REQUIRED 时，把「确认要求 + 携 token
// 重发」丢进这里，由 App 级 SkillCautionPromptHost（components/
// SkillCautionPromptHost.tsx）弹设置页同款 SkillCautionDisclosureModal。
// 放 services 层：调用方是 service（skillLocalZip）与 component
// （SlashCommandPopover），方向只能 component → service。
// 状态形状抄 sideChatFloaterState：模块级单例 + 监听器，一次只挂一个请求，
// 新请求顶掉旧请求（旧轮次视为已确认，由新轮次接管）。
// ============================================================================

import { IPC_CHANNELS } from '@shared/ipc';
import type { SkillCautionConfirmationRequired } from '@shared/contract/skillInstallCaution';
import { invoke } from './ipcService';
import { isSkillCautionConfirmationRequired } from './skillInstallCaution';

export interface SkillCautionPromptRequest {
  id: number;
  required: SkillCautionConfirmationRequired;
  /**
   * 确认 = 携 host 下发的 token 原样重发。返回 true = 流程收尾（成功/失败都已
   * 按正常路径处理）→ 关窗；返回 false = 已携新命中重开（内容变化的二次确认）。
   */
  retry: (cautionConfirmationToken: string) => Promise<boolean>;
  resolve: (confirmed: boolean) => void;
}

let current: SkillCautionPromptRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 确认面宿主（SkillCautionPromptHost）是否在挂载——不在线时无人能确认 */
function isSkillCautionPromptHostMounted(): boolean {
  return listeners.size > 0;
}

/**
 * 弹确认面，等这一轮的结局。resolve(true) = 确认并收尾（可能经过几次重开）；
 * resolve(false) = 用户取消（host 侧本就未落盘）或宿主未挂载（fail-closed，
 * 调用方按各自入口的失败路径收口）。模块内消费方是 installWithSkillCautionConfirm
 * 的首发/重开两处，外部入口一律走那个驱动，故不导出（knip：真有人 import 才导）。
 */
function requestSkillCautionConfirm(
  required: SkillCautionConfirmationRequired,
  retry: (cautionConfirmationToken: string) => Promise<boolean>,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (listeners.size === 0) {
      resolve(false);
      return;
    }
    // 被新请求顶掉的旧轮次按「已确认」收尾：确认动作已发生，弹窗内容换由新轮次接管
    current?.resolve(true);
    seq += 1;
    current = { id: seq, required, retry, resolve };
    emit();
  });
}

export function getSkillCautionPromptRequest(): SkillCautionPromptRequest | null {
  return current;
}

/** 宿主收尾（确认完成/取消）后清请求，避免重挂时旧弹窗回魂 */
export function clearSkillCautionPrompt(id: number): void {
  if (current?.id !== id) return;
  current = null;
  emit();
}

export function subscribeSkillCautionPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 安装通道的终态结果（confirmation-required 之外的共同形状） */
export interface SkillCautionInstallOutcome {
  success: boolean;
  error?: string;
  skillName?: string;
}

/**
 * 「首发安装 → confirmation-required → 弹确认面 → 确认携 token 重发」的通用驱动。
 * settle 只会拿到非 confirmation-required 的终态结果（成功/普通失败各自处理），
 * 返回 true 视为收尾关窗。返回值 = 整个流程的结局：false 是取消或宿主未挂载，
 * 可选的 onUnavailable 只在「命中确认门但宿主不在」时补一声失败提示。
 */
export async function installWithSkillCautionConfirm(args: {
  send: (cautionConfirmationToken?: string) => Promise<SkillCautionInstallOutcome | SkillCautionConfirmationRequired>;
  settle: (result: SkillCautionInstallOutcome) => boolean | Promise<boolean>;
  onUnavailable?: () => void;
}): Promise<boolean> {
  const retry = async (cautionConfirmationToken: string): Promise<boolean> => {
    const result = await args.send(cautionConfirmationToken);
    if (isSkillCautionConfirmationRequired(result)) {
      // 内容变化：携新命中重开确认面（新请求顶掉当前轮），本轮确认不算收尾
      void requestSkillCautionConfirm(result, retry);
      return false;
    }
    return args.settle(result);
  };
  const first = await args.send();
  if (isSkillCautionConfirmationRequired(first)) {
    if (!isSkillCautionPromptHostMounted()) {
      args.onUnavailable?.();
      return false;
    }
    return requestSkillCautionConfirm(first, retry);
  }
  return args.settle(first);
}

/**
 * /plugins install 的确认驱动：确认门契约穿过 EXTENSION_INSTALL 后在这里分流。
 * 取消/宿主不在 → 抛错（命令层按安装失败收口，不打印 Installed）；普通失败也
 * 抛原始 error，保持 handleMutation 时代的报错语义。
 */
export async function installExtensionWithSkillCautionConfirm(spec: string): Promise<void> {
  let failure: string | undefined;
  const confirmed = await installWithSkillCautionConfirm({
    send: (cautionConfirmationToken) => invoke(IPC_CHANNELS.EXTENSION_INSTALL, spec, cautionConfirmationToken),
    settle: (result) => {
      if (!result.success) failure = result.error || 'Extension operation failed';
      return true;
    },
  });
  if (!confirmed) throw new Error('Skill install cancelled before confirmation');
  if (failure) throw new Error(failure);
}

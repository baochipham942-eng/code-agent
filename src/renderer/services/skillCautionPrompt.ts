// ============================================================================
// skillCautionPrompt - 聊天面 skill caution 确认面（外部 store + 安装驱动）
// ============================================================================
// 拖拽 ZIP / /plugins install 这些入口不在设置页里，没有自己的确认弹窗：host 侧
// caution 门回 SKILL_CAUTION_CONFIRMATION_REQUIRED 时，把「确认要求 + 携 token
// 重发」丢进这里，由 App 级 SkillCautionPromptHost（components/
// SkillCautionPromptHost.tsx）弹设置页同款 SkillCautionDisclosureModal。
// 放 services 层：调用方是 service（skillLocalZip）与 component
// （SlashCommandPopover），方向只能 component → service。
// 结算模型（r1）：一次安装流程（installWithSkillCautionConfirm 的一趟）= 一条
// chain，chain 独占外层 Promise 的结算权，可跨多轮确认——内容变化重开只换弹窗
// 内容不动结算，resolve(true) 只在最后一轮 settle 跑完后发生；取消、被新流程
// 顶掉、宿主未挂载一律 resolve(false)=未安装，让调用方走各自入口的失败路径，
// 绝不把「已确认」冒充「已安装」。模块级单例 + 监听器，一次只挂一个请求。
// ============================================================================

import { IPC_CHANNELS } from '@shared/ipc';
import type { SkillCautionConfirmationRequired } from '@shared/contract/skillInstallCaution';
import { invoke } from './ipcService';
import { isSkillCautionConfirmationRequired } from './skillInstallCaution';

/**
 * 一条确认链 = 一次安装流程的对外结算权。同流程的多轮确认（内容变化重开）
 * 共享同一个 chain：弹窗轮次随便换，外层结算只有这一个。
 */
interface SkillCautionChain {
  settle: (confirmed: boolean) => void;
  /** 被新流程顶掉时补一口（拖拽入口把 zip 按附件回流，不当已安装也不静默丢） */
  onSuperseded?: () => void;
}

export interface SkillCautionPromptRequest {
  id: number;
  required: SkillCautionConfirmationRequired;
  /**
   * 确认 = 携 host 下发的 token 原样重发。返回 true = 流程收尾（成功/失败都已
   * 按正常路径处理）→ 关窗；返回 false = 已携新命中重开（内容变化的二次确认）。
   */
  retry: (cautionConfirmationToken: string) => Promise<boolean>;
  /**
   * 结算整个安装流程的结局（chain 级，跨重开轮次共享）：true 仅在最后一轮
   * settle 跑完后由宿主调用；false = 用户取消或被新流程顶掉（host 侧本就未
   * 落盘）→ 调用方按未安装收口。
   */
  resolve: (confirmed: boolean) => void;
}

interface SkillCautionRound extends SkillCautionPromptRequest {
  chain: SkillCautionChain;
}

let current: SkillCautionRound | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 确认面宿主（SkillCautionPromptHost）是否在挂载——不在线时无人能确认 */
function isSkillCautionPromptHostMounted(): boolean {
  return listeners.size > 0;
}

function mountRound(
  required: SkillCautionConfirmationRequired,
  retry: (cautionConfirmationToken: string) => Promise<boolean>,
  chain: SkillCautionChain,
): void {
  seq += 1;
  current = { id: seq, required, retry, resolve: chain.settle, chain };
  emit();
}

/**
 * 新流程开窗（首发 confirmation-required）。已在挂的旧流程被顶掉时按「未安装」
 * 结算（false）：它要么还没等到用户确认、要么确认重发在途未落盘，调用方必须
 * 走失败路径收口，不能当已确认/已安装。
 */
function openSkillCautionPrompt(
  required: SkillCautionConfirmationRequired,
  retry: (cautionConfirmationToken: string) => Promise<boolean>,
  chain: SkillCautionChain,
): void {
  // settle 是 promise resolve，幂等：已结算过的链再调一次是无害 no-op
  current?.chain.settle(false);
  current?.chain.onSuperseded?.();
  mountRound(required, retry, chain);
}

/**
 * 同流程重开（确认后内容变化，携新命中再来一轮）：只换弹窗内容，外层结算不动，
 * 留给最后一轮 settle。窗口已易主（本流程被新流程顶掉、已按未安装结算）时直接
 * 丢弃——死流程的迟到重开不得抢走活流程的确认窗。
 */
function reopenSkillCautionPrompt(
  required: SkillCautionConfirmationRequired,
  retry: (cautionConfirmationToken: string) => Promise<boolean>,
  chain: SkillCautionChain,
): void {
  if (current?.chain !== chain) return;
  mountRound(required, retry, chain);
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
 * 一次调用的全部确认轮次共享一条 chain：内容变化重开不结算外层，最后一轮 settle
 * 跑完才 resolve(true)（失败也已由 settle 按正常路径处理）；取消/被新流程顶掉/
 * 宿主未挂载则 resolve(false)=未安装。onUnavailable 只在「命中确认门但宿主不在」
 * 时补一声失败提示；onSuperseded 只在「被新流程顶掉」时补一口（拖拽入口据此把
 * zip 按附件回流）。
 */
export async function installWithSkillCautionConfirm(args: {
  send: (cautionConfirmationToken?: string) => Promise<SkillCautionInstallOutcome | SkillCautionConfirmationRequired>;
  settle: (result: SkillCautionInstallOutcome) => boolean | Promise<boolean>;
  onUnavailable?: () => void;
  onSuperseded?: () => void;
}): Promise<boolean> {
  const first = await args.send();
  if (!isSkillCautionConfirmationRequired(first)) return args.settle(first);
  if (!isSkillCautionPromptHostMounted()) {
    args.onUnavailable?.();
    return false;
  }
  return new Promise<boolean>((settle) => {
    const chain: SkillCautionChain = { settle, onSuperseded: args.onSuperseded };
    const retry = async (cautionConfirmationToken: string): Promise<boolean> => {
      const result = await args.send(cautionConfirmationToken);
      if (isSkillCautionConfirmationRequired(result)) {
        reopenSkillCautionPrompt(result, retry, chain);
        return false;
      }
      return args.settle(result);
    };
    openSkillCautionPrompt(first, retry, chain);
  });
}

/**
 * /plugins install 的确认驱动：确认门契约穿过 EXTENSION_INSTALL 后在这里分流。
 * 取消/被顶掉/宿主不在 → 抛错（命令层按安装失败收口，不打印 Installed）；普通
 * 失败也抛原始 error，保持 handleMutation 时代的报错语义。
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

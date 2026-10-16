// ============================================================================
// skillCautionPrompt - 聊天面 skill caution 确认面（外部 store + 安装驱动）
// ============================================================================
// 拖拽 ZIP / /plugins install 这些入口不在设置页里，没有自己的确认弹窗：host 侧
// caution 门回 SKILL_CAUTION_CONFIRMATION_REQUIRED 时，把「确认要求 + 携 token
// 重发」丢进这里，由 App 级 SkillCautionPromptHost（components/
// SkillCautionPromptHost.tsx）弹设置页同款 SkillCautionDisclosureModal。
// 放 services 层：调用方是 service（skillLocalZip）与 component
// （SlashCommandPopover），方向只能 component → service。
// 结算模型（r1，r3 修顶掉竞态）：一次安装流程（installWithSkillCautionConfirm
// 的一趟）= 一条 chain，chain 独占外层 Promise 的结算权，只结算一次，可跨多轮
// 确认——内容变化重开只换弹窗内容不动结算；确认重发落地的一拍内按真实结局结算
// （settle 回调跑完 = done，chain 结算 true，成败都算「流程收尾」）；取消、被
// 新流程顶掉时重发不在途、宿主未挂载一律结算 false=未安装，让调用方走各自入口
// 的失败路径，绝不把「已确认」冒充「已安装」。被顶掉时重发在途的 chain 不抢先
// 结算——重发马上落地，装成功却被报取消/回流附件是谎报，结局以重发落地为准。
// 模块级单例 + 监听器，一次只挂一个请求。
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
  /** 被顶掉且按未安装结算时补一口（拖拽入口把 zip 按附件回流，不当已安装也不静默丢） */
  onSuperseded?: () => void;
  /** 确认重发已发出未返回：被顶掉时结算推迟到重发落地，按真实结局收口 */
  pendingRetry?: boolean;
  /** 已被新流程顶掉（死流程，确认窗口易主） */
  superseded?: boolean;
  /** 已结算：整条 chain 只结算一次，onSuperseded 只补一口 */
  settled?: boolean;
}

export interface SkillCautionPromptRequest {
  id: number;
  required: SkillCautionConfirmationRequired;
  /**
   * 确认 = 携 host 下发的 token 原样重发。返回 true = 流程收尾（成功/失败都已
   * 按正常路径处理，chain 已在重发落地的一拍内结算）→ 关窗；返回 false = 已携
   * 新命中重开（内容变化的二次确认），或本轮已被新流程顶掉（宿主回调据此不关
   * 当前显示着的别人的窗）。
   */
  retry: (cautionConfirmationToken: string) => Promise<boolean>;
  /**
   * 结算整个安装流程的结局（chain 级，跨重开轮次共享，幂等只结算一次）：false =
   * 用户取消（确认重发落地后的收尾不走这里，chain 已在重发内结算）→ 调用方按
   * 未安装收口。
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

/**
 * chain 级结算（幂等，只结算一次）。onSuperseded 只在被顶掉且按未安装收口时补：
 * 在途重发后来落地的流程是正常收尾（成功/失败都已按真实路径处理），不算被丢下，
 * 不得回流附件。
 */
function settleChain(chain: SkillCautionChain, confirmed: boolean): void {
  if (chain.settled) return;
  chain.settled = true;
  chain.settle(confirmed);
  if (!confirmed && chain.superseded) chain.onSuperseded?.();
}

function mountRound(
  required: SkillCautionConfirmationRequired,
  retry: (cautionConfirmationToken: string) => Promise<boolean>,
  chain: SkillCautionChain,
): void {
  seq += 1;
  current = {
    id: seq,
    required,
    // 重发在途标记在这里包：宿主回调 → 真正发出 send 之间没有间隙，顶掉判断
    // （openSkillCautionPrompt）不会漏看在途重发
    retry: async (cautionConfirmationToken: string) => {
      chain.pendingRetry = true;
      try {
        return await retry(cautionConfirmationToken);
      } finally {
        chain.pendingRetry = false;
      }
    },
    resolve: (confirmed: boolean) => settleChain(chain, confirmed),
    chain,
  };
  emit();
}

/**
 * 新流程开窗（首发 confirmation-required）。已在挂的旧流程被顶掉：还没等到用户
 * 确认的立即按「未安装」结算（false），调用方走失败路径收口，不能当已确认/已安装；
 * 确认重发在途的不抢先结算——重发马上落地，真实结局可能是已装上，装成功却被报
 * 取消/回流附件是谎报，留给重发落地（成功/失败/二次确认被丢弃/重发炸了）结算。
 */
function openSkillCautionPrompt(
  required: SkillCautionConfirmationRequired,
  retry: (cautionConfirmationToken: string) => Promise<boolean>,
  chain: SkillCautionChain,
): void {
  const prev = current?.chain;
  if (prev) {
    prev.superseded = true;
    if (!prev.pendingRetry) settleChain(prev, false);
  }
  mountRound(required, retry, chain);
}

/**
 * 同流程重开（确认后内容变化，携新命中再来一轮）：只换弹窗内容，外层结算不动，
 * 留给最后一轮 settle。窗口已易主（本流程被新流程顶掉）时直接丢弃——死流程的
 * 迟到重开不得抢走活流程的确认窗；这条流程已无确认面可走，按未安装结算收口。
 */
function reopenSkillCautionPrompt(
  required: SkillCautionConfirmationRequired,
  retry: (cautionConfirmationToken: string) => Promise<boolean>,
  chain: SkillCautionChain,
): void {
  if (current?.chain !== chain) {
    if (chain.superseded) settleChain(chain, false);
    return;
  }
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
      try {
        const result = await args.send(cautionConfirmationToken);
        if (isSkillCautionConfirmationRequired(result)) {
          reopenSkillCautionPrompt(result, retry, chain);
          return false;
        }
        const done = await args.settle(result);
        // 收尾在重发落地的一拍内结算，不留给宿主回调的下一拍：这一拍里被新流程
        // 顶掉也不能把已发生的真实结局改写成未安装
        if (done) settleChain(chain, true);
        return done;
      } catch (err) {
        // 重发/收尾炸了：已被顶掉的死流程没人能再替它确认或取消，按未安装收口，
        // 不让外层 promise 悬空；活流程保持未结算，弹窗开着等用户重试或取消
        if (chain.superseded) settleChain(chain, false);
        throw err;
      }
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

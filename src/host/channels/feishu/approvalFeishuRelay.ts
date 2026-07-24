// ============================================================================
// Approval → Feishu relay (B3)
// ============================================================================
//
// 无人值守工具审批停车挂起（B2）后，把「有操作等你批准」镜像到关联的飞书会话，
// 并支持点飞书卡片按钮直接批准/拒绝。收件箱仍是主入口，飞书是镜像增强：
//   - 出站：订阅 approvalParkEvents('parked') → 发交互卡片（人话 + external 徽标 + 双按钮）
//   - 入站：飞书按钮回调 → channelManager('card_action') → 解码 → resolveParkedApproval
//   - 收尾：approvalParkEvents('resolved') → 把卡片更新成「已批准/已拒绝」（去按钮）
//
// 只对 origin.kind==='channel' 且 channelType∈{feishu,lark} 的 session 生效；没配飞书零影响。
// 回批是「第三口」，与会话卡/收件箱同样汇入 resolveParkedApproval（repo changes 裁决，
// first-responder-wins，重复点击/多口抢答天然幂等）。
// ============================================================================

import { approvalParkEvents } from '../../agent/approvalParkEvents';
import { getChannelManager } from '../channelManager';
import { getSessionManager } from '../../services';
import { getTaskManager } from '../../task';
import { createLogger } from '../../services/infra/logger';
import type { SendMessageResult } from '../../../shared/contract/channel';
import type { PermissionResponse } from '../../../shared/contract/permission';

const logger = createLogger('ApprovalFeishuRelay');

const FEISHU_CHANNEL_TYPES = new Set(['feishu', 'lark']);
/** 按钮 value 里的判据标签，区分本 relay 的审批按钮与任何其它卡片动作。 */
const APPROVAL_VALUE_TAG = 'apv';

interface ApprovalCardRecord {
  accountId: string;
  chatId: string;
  messageId: string;
  tool: string;
}

/** FeishuChannel 的卡片子集（sendCard/updateCard 不在 IChannelPlugin 上）。 */
interface FeishuCardApi {
  sendCard(
    chatId: string,
    text: string,
    buttons?: Array<{ text: string; value: string }>,
  ): Promise<SendMessageResult>;
  updateCard(messageId: string, text: string): Promise<SendMessageResult>;
}

/**
 * 结构判据：目标 accountId 已经过 resolveFeishuTarget 的 channelType∈{feishu,lark} 校验，
 * 故该实例必是 FeishuChannel；这里只做 sendCard/updateCard 的类型收窄，避免 relay 依赖
 * SDK 重的 feishuChannel 模块（也便于单测用普通 mock 驱动）。
 */
function hasFeishuCardApi(channel: unknown): channel is FeishuCardApi {
  return (
    !!channel
    && typeof (channel as FeishuCardApi).sendCard === 'function'
    && typeof (channel as FeishuCardApi).updateCard === 'function'
  );
}

interface DecodedApprovalValue {
  resolution: PermissionResponse;
  approvalId: string;
  sessionId: string;
}

/** 把 (resolution, approvalId, sessionId) 编进按钮 value；JSON 避免分隔符与 id 冲突。 */
function encodeApprovalValue(
  resolution: 'allow' | 'deny',
  approvalId: string,
  sessionId: string,
): string {
  return JSON.stringify({ t: APPROVAL_VALUE_TAG, r: resolution, a: approvalId, s: sessionId });
}

/** 解码飞书按钮回传的 value。非本 relay 的按钮 / 结构不符一律返回 null（忽略，不误裁决）。 */
export function decodeApprovalValue(value: string | undefined | null): DecodedApprovalValue | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.t !== APPROVAL_VALUE_TAG) return null;
  const { r, a, s } = record;
  if ((r !== 'allow' && r !== 'deny') || typeof a !== 'string' || typeof s !== 'string') return null;
  return { resolution: r, approvalId: a, sessionId: s };
}

/** 卡片人话正文：工具名 + external 徽标 + 「收件箱也能处理」提示。 */
function buildParkedCardText(tool: string, riskClass: string | null | undefined): string {
  const lines = ['**有操作等你批准**', `无人值守任务想执行 \`${tool}\`。`];
  if (riskClass === 'external') {
    lines.push('⚠️ 离开本机：该操作会发送到外部，发出后收不回。');
  }
  lines.push('在收件箱也能处理；点下方按钮可直接批准或拒绝。');
  return lines.join('\n');
}

/** sessionId → 关联的飞书账号/会话；非飞书 channel session 返回 null。 */
async function resolveFeishuTarget(
  sessionId: string | null,
): Promise<{ accountId: string; chatId: string } | null> {
  if (!sessionId) return null;
  const session = await getSessionManager().getSession(sessionId, 1);
  const origin = session?.origin;
  if (origin?.kind !== 'channel') return null;
  const md = origin.metadata ?? {};
  const channelType = typeof md.channelType === 'string' ? md.channelType : undefined;
  const accountId = typeof md.accountId === 'string' ? md.accountId : undefined;
  const chatId = typeof md.chatId === 'string' ? md.chatId : undefined;
  if (!channelType || !FEISHU_CHANNEL_TYPES.has(channelType) || !accountId || !chatId) return null;
  return { accountId, chatId };
}

export class ApprovalFeishuRelay {
  /** approvalId → 已发出的卡片位置，供 resolved 时更新卡片状态。 */
  private readonly cards = new Map<string, ApprovalCardRecord>();
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    approvalParkEvents.on('parked', (event) => {
      void this.onParked(event);
    });
    approvalParkEvents.on('resolved', (event) => {
      void this.onResolved(event);
    });
    getChannelManager().on('card_action', (_accountId: string, payload: { value?: string }) => {
      void this.onCardAction(payload?.value);
    });
    logger.info('Approval → Feishu relay started');
  }

  private async onParked(event: {
    id: string;
    sessionId: string | null;
    tool: string;
    riskClass?: string | null;
  }): Promise<void> {
    try {
      // sessionId 缺失就无法把回批路由回对的 orchestrator——不发（收件箱仍可处理）。
      if (!event.sessionId) return;
      const target = await resolveFeishuTarget(event.sessionId);
      if (!target) return; // 没配飞书 / 非飞书 channel session：零影响
      const channel = getChannelManager().getActiveChannel(target.accountId);
      if (!hasFeishuCardApi(channel)) return;

      const buttons = [
        { text: '✅ 批准', value: encodeApprovalValue('allow', event.id, event.sessionId) },
        { text: '⛔ 拒绝', value: encodeApprovalValue('deny', event.id, event.sessionId) },
      ];
      const result = await channel.sendCard(
        target.chatId,
        buildParkedCardText(event.tool, event.riskClass),
        buttons,
      );
      if (result.success && result.messageId) {
        this.cards.set(event.id, {
          accountId: target.accountId,
          chatId: target.chatId,
          messageId: result.messageId,
          tool: event.tool,
        });
      }
    } catch (err) {
      logger.warn('Failed to mirror parked approval to Feishu', err);
    }
  }

  private async onResolved(event: {
    id: string;
    sessionId: string | null;
    status: 'approved' | 'rejected';
  }): Promise<void> {
    const record = this.cards.get(event.id);
    if (!record) return;
    this.cards.delete(event.id);
    try {
      const channel = getChannelManager().getActiveChannel(record.accountId);
      if (!hasFeishuCardApi(channel)) return;
      const label = event.status === 'approved' ? '✅ 已批准' : '⛔ 已拒绝';
      await channel.updateCard(record.messageId, `${label}：\`${record.tool}\``);
    } catch (err) {
      logger.warn('Failed to update resolved approval card', err);
    }
  }

  private async onCardAction(value: string | undefined): Promise<void> {
    const decoded = decodeApprovalValue(value);
    if (!decoded) return; // 非审批按钮：忽略
    // 停车的 run 仍活着（24h 兜底），orchestrator 应在 registry 里。找不到 = 已收尾/孤儿，
    // 静默 no-op；即便找到，resolveParkedApproval 也是 repo 裁决幂等的。
    const orchestrator = getTaskManager().getOrchestrator(decoded.sessionId);
    if (!orchestrator) {
      logger.info('Parked approval orchestrator gone, ignoring Feishu button', {
        sessionId: decoded.sessionId,
      });
      return;
    }
    orchestrator.resolveParkedApproval(decoded.approvalId, decoded.resolution);
  }
}

let relaySingleton: ApprovalFeishuRelay | null = null;

/** 进程级单例启动。createAgentRuntime 在 channel bridge 之后调用一次。 */
export function initApprovalFeishuRelay(): ApprovalFeishuRelay {
  if (!relaySingleton) {
    relaySingleton = new ApprovalFeishuRelay();
    relaySingleton.start();
  }
  return relaySingleton;
}

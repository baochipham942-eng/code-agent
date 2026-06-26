// ============================================================================
// confirmGenerationCost — 会话内成本确认卡（Slice A）
//
// 付费生成（图片/视频/演示稿配图）出图前的「消耗 ¥X，是否继续？」确认。
// 复用 promptUserInChat round-trip，渲染成对话流卡片，不落画布审批条 / 不弹
// window.confirm —— 决策在会话区做，不抢用户焦点（产物仍落画布/预览 tab）。
//
// fail-closed：无 renderer / 超时 / abort / 取消 → false，绝不花钱。
// ============================================================================
import type { UserQuestion } from '../../../../shared/contract';
import { formatCny } from '../../../../shared/media/imageCost';
import { promptUserInChat } from '../../utils/userQuestionPrompt';

const COST_CONFIRM_HEADER = '成本确认';

export interface GenerationCostConfirmInput {
  /** 媒介中文名，如「图片」「视频」「演示稿配图」。 */
  mediaLabel: string;
  /** 预估成本（人民币元），取自共享价表（imageCost/videoCost），禁硬编码。 */
  estCny: number;
  /** 数量/时长等明细，如「2 张」「5 秒」。 */
  detail?: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
}

/**
 * 弹出会话内成本确认卡，返回用户是否同意花钱。
 * 仅当用户明确点「确认」才返回 true；其余一律 false（不花钱）。
 */
export async function confirmGenerationCost(
  input: GenerationCostConfirmInput,
): Promise<boolean> {
  const cost = formatCny(input.estCny);
  const confirmLabel = `确认 ${cost}`;
  const detailSuffix = input.detail ? `（${input.detail}）` : '';

  const question: UserQuestion = {
    header: COST_CONFIRM_HEADER,
    question: `本次生成${input.mediaLabel}将消耗 ${cost}${detailSuffix}，是否继续？`,
    options: [
      { label: confirmLabel, description: '确认并开始生成，将产生上述费用' },
      { label: '取消', description: '不生成，不产生费用' },
    ],
  };

  const result = await promptUserInChat([question], {
    sessionId: input.sessionId,
    abortSignal: input.abortSignal,
    notify: { title: '生成成本确认', body: question.question },
  });

  if (result.status !== 'answered' || !result.response) return false;
  const answer = result.response.answers[COST_CONFIRM_HEADER];
  const picked = Array.isArray(answer) ? answer[0] : answer;
  return picked === confirmLabel;
}

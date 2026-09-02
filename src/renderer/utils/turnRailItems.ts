// ============================================================================
// 轮次导航条目（N-TURNRAIL）：每轮一项，预览取「用户那句 + 本轮最后一条有正文的
// Neo 回复」——与 TurnCard 折叠视图同一口径（取法抽到这里，两处共用不复制）。
// 历史是整段加载的（restoreSession 走账本全量回放），所以没有「未加载」态；
// 跳转直接 scrollToIndex。
// ============================================================================
import type { TraceNode, TraceTurn } from '@shared/contract/trace';

export interface TurnRailItem {
  turnId: string;
  turnNumber: number;
  /** 用户那句的一行预览（≤ 50 字，超出加「…」）；没有文字的轮为空串 */
  prompt: string;
  /** 本轮结论的一行预览（≤ 120 字）；轮未结束或没有文字为空串 */
  response: string;
}

/** 爸 09-02 定：短会话不需要导航。1440×900 下一轮约 250–400px，8 轮 ≈ 3 屏，是需要位置感的起点。 */
export const TURN_RAIL_MIN_TURNS = 8;

const PROMPT_PREVIEW_MAX = 50;
const RESPONSE_PREVIEW_MAX = 120;

export function getTurnUserNode(turn: TraceTurn): TraceNode | null {
  return turn.nodes.find((node) => node.type === 'user') ?? null;
}

/**
 * 「结论」= 这一轮最后一条有正文的 assistant 文本。语音任务卡里要把派活指令节点
 * 自己排除掉——它也是 assistant_text 且有正文（改写后的指令）。
 */
export function getTurnFinalTextNode(turn: TraceTurn, isVoiceTurn: boolean): TraceNode | null {
  for (let index = turn.nodes.length - 1; index >= 0; index -= 1) {
    const node = turn.nodes[index];
    if (
      node.type === 'assistant_text'
      && typeof node.content === 'string'
      && node.content.trim().length > 0
      && !(isVoiceTurn && node.metadata?.voiceDispatch)
    ) {
      return node;
    }
  }
  return null;
}

function previewText(content: string | undefined, max: number): string {
  const collapsed = (content ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${Array.from(collapsed).slice(0, max).join('')}…`;
}

function isVoiceTurn(turn: TraceTurn): boolean {
  return turn.nodes.some((node) => Boolean(node.metadata?.voiceDispatch));
}

export function buildTurnRailItems(turns: readonly TraceTurn[]): TurnRailItem[] {
  return turns.map((turn) => ({
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    prompt: previewText(getTurnUserNode(turn)?.content, PROMPT_PREVIEW_MAX),
    response: previewText(getTurnFinalTextNode(turn, isVoiceTurn(turn))?.content, RESPONSE_PREVIEW_MAX),
  }));
}

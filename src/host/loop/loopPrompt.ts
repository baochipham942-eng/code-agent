// ============================================================================
// Loop 轮次 prompt 构造与停止信号解析（纯函数，无 main 依赖，便于单测）
// ============================================================================

import { LOOP_DONE_MARKER, LOOP_WAIT_MARKER } from '../../shared/contract/loop';

const MS_PER_SECOND = 1_000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 给每一轮构造发给 agent 的 prompt：主体 + 循环上下文指令。 */
export function buildTurnPrompt(state: {
  prompt: string;
  turn: number;
  until?: string;
  intervalMs?: number;
}): string {
  const directives: string[] = [`【循环模式 · 第 ${state.turn} 轮】`];
  if (state.until) {
    directives.push(
      `当你判断「${state.until}」已经满足时，在回复最后单独输出一行：${LOOP_DONE_MARKER}`,
    );
  }
  if (state.intervalMs === undefined) {
    directives.push(
      `如果还需要继续，可在回复最后单独输出一行 ${LOOP_WAIT_MARKER} <秒数> 指定下一轮间隔；不输出则立即继续。`,
    );
  }
  return `${state.prompt}\n\n${directives.join('\n')}`;
}

/** agent 是否在回复里给出了「软条件已满足」的停止标记。 */
export function detectDoneMarker(reply: string): boolean {
  return reply.includes(LOOP_DONE_MARKER);
}

/** 自定步调：从回复里解析 `[[LOOP_WAIT]] <秒数>`，返回毫秒；无/非正数返回 null。 */
export function parseWaitMs(reply: string): number | null {
  const m = new RegExp(`${escapeRegExp(LOOP_WAIT_MARKER)}\\s+(\\d+)`).exec(reply);
  if (!m) return null;
  const sec = parseInt(m[1], 10);
  return Number.isFinite(sec) && sec > 0 ? sec * MS_PER_SECOND : null;
}

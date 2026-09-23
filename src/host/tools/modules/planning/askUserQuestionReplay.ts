// ============================================================================
// AskUserQuestion 同轮重复问句回放（N-ASKUSER-REPEAT-REPLAY）
//
// 同一轮里模型字面重复问同一组问题时，不再弹卡/不再走审批，直接回放上次答案。
// 「同问」= 归一化字面相同：选项顺序、空白、标点、大小写、全半角不算差异；
// 选项集合不同（含新增选项）属于语义不同，必须照弹——宁可多弹。
// 缓存键 = (sessionId, turnId ?? runId, 归一化问句)，生命周期绑 run：
// RunFinalizer.finalizeRun 调 clearAskUserQuestionReplayForSession 清空。
// ============================================================================

import type { ToolContext } from '../../../protocol/tools';
import type { UserQuestion } from '../../../../shared/contract';
import { ASK_USER_QUESTION_REPLAY_SUFFIX } from '../../../../shared/contract/askUserQuestion';

const replayCache = new Map<string, string>();

function normalizeQuestionText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '');
}

export function buildAskUserQuestionReplayKey(questions: UserQuestion[]): string {
  return questions
    .map((q) => {
      const options = q.options
        .map((o) => `${normalizeQuestionText(o.label)}${normalizeQuestionText(o.description)}`)
        .sort()
        .join('\u0002');
      return [
        normalizeQuestionText(q.header),
        normalizeQuestionText(q.question),
        q.multiSelect ? 'multi' : 'single',
        options,
      ].join('\u0001');
    })
    .join('\u0003');
}

function cacheKey(ctx: ToolContext, questions: UserQuestion[]): string | undefined {
  const scope = ctx.turnId ?? ctx.runId;
  if (!scope) return undefined;
  return `${ctx.sessionId}\u0004${scope}\u0004${buildAskUserQuestionReplayKey(questions)}`;
}

export function lookupAskUserQuestionReplay(
  ctx: ToolContext,
  questions: UserQuestion[],
): string | undefined {
  const key = cacheKey(ctx, questions);
  if (!key) return undefined;
  const cached = replayCache.get(key);
  return cached === undefined ? undefined : cached + ASK_USER_QUESTION_REPLAY_SUFFIX;
}

export function recordAskUserQuestionAnswer(
  ctx: ToolContext,
  questions: UserQuestion[],
  output: string,
): void {
  const key = cacheKey(ctx, questions);
  if (!key) return;
  replayCache.set(key, output);
}

export function clearAskUserQuestionReplayForSession(sessionId: string): void {
  const prefix = `${sessionId}\u0004`;
  for (const key of replayCache.keys()) {
    if (key.startsWith(prefix)) replayCache.delete(key);
  }
}

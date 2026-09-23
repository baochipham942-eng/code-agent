// ============================================================================
// AskUserQuestion 同轮重复问句回放（N-ASKUSER-REPEAT-REPLAY）
//
// 同一 run 里模型字面重复问同一组问题时，不再弹卡/不再走审批，直接回放上次答案。
// 「同问」= 归一化字面相同：选项顺序、空白、标点、大小写、全半角不算差异；
// 选项集合不同（含新增选项）属于语义不同，必须照弹——宁可多弹。
// 缓存键 = (sessionId, runId, 归一化问句)：turnId 每次模型迭代由
// streamHandler.setupIteration 重新生成，不能作作用域；「同轮」= 同一 run。
// 生命周期绑 run：RunFinalizer.finalizeRun 调 clearAskUserQuestionReplay 精确清。
// 模块级 Map 封顶 REPLAY_CACHE_MAX 条，满即淘汰最旧（Map 迭代序=插入序），
// 防止 run 异常未走 finalize 时条目常驻。
// ============================================================================

import type { ToolContext } from '../../../protocol/tools';
import type { UserQuestion } from '../../../../shared/contract';
import { ASK_USER_QUESTION_REPLAY_SUFFIX } from '../../../../shared/contract/askUserQuestion';

const REPLAY_CACHE_MAX = 200;

const replayCache = new Map<string, string>();

function normalizeQuestionText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '');
}

function buildAskUserQuestionReplayKey(questions: UserQuestion[]): string {
  return questions
    .map((q) => {
      const options = q.options
        .map((o) => `${normalizeQuestionText(o.label ?? '')}${normalizeQuestionText(o.description ?? '')}`)
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
  const scope = ctx.runId ?? ctx.turnId;
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
  if (replayCache.size > REPLAY_CACHE_MAX) {
    const oldest = replayCache.keys().next();
    if (!oldest.done) replayCache.delete(oldest.value);
  }
}

export function clearAskUserQuestionReplay(sessionId: string, runId?: string): void {
  if (runId) {
    const prefix = `${sessionId}\u0004${runId}\u0004`;
    for (const key of replayCache.keys()) {
      if (key.startsWith(prefix)) replayCache.delete(key);
    }
    return;
  }
  const prefix = `${sessionId}\u0004`;
  for (const key of replayCache.keys()) {
    if (key.startsWith(prefix)) replayCache.delete(key);
  }
}

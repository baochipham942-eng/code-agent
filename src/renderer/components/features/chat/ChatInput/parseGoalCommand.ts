// ============================================================================
// /goal 斜杠命令解析
//   /goal <目标文本> [--verify "<shell 命令>"] [--review "<软条件>"]
//                    [--max-turns <N>] [--budget <N>] [--max-time <分钟>]
// verify/review 值可用单/双引号包裹（含空格时必须），或裸写（取到下一个 flag 前）。
// 解析结果交给 ChatInput 校验 goal 非空；未显式提供 verify/review 时走默认软目标评审。
// ============================================================================

import { zh, type Translations } from '../../../../i18n/zh';

export interface ParsedGoalCommand {
  goal: string;
  verify?: string;
  review?: string;
  maxTurns?: number;
  budget?: number;
  /** 闸3：墙钟时间预算（ms）。命令行 --max-time 收分钟，解析时转 ms。 */
  wallClockBudgetMs?: number;
}

export interface GoalComposerDraft {
  goal: string;
  verify?: string;
  acceptance?: string;
  boundaries?: string;
  pauseConditions?: string;
  maxTurns?: number;
  budget?: number;
  /** 墙钟时间预算（分钟，UI 友好单位）；透传时转 ms。 */
  wallClockMinutes?: number;
}

/** 是否是 /goal 命令（用于 handleSubmit 提前拦截判断）。 */
export function isGoalCommand(raw: string): boolean {
  return /^\/goal\b/.test(raw.trim());
}

const FLAG_NAMES = 'verify|review|max-turns|budget|max-time';
// 第一个 flag 的位置（行首或空白后跟 --flag）
const FIRST_FLAG_RE = new RegExp(`(^|\\s)--(?:${FLAG_NAMES})\\b`);
// 单个 flag + 值：值为双引号 / 单引号 / 裸值（裸值取到下一个 flag 前；s 让 . 跨行）
const FLAG_VALUE_RE = new RegExp(
  `--(${FLAG_NAMES})\\s+("([^"]*)"|'([^']*)'|((?:(?!\\s--(?:${FLAG_NAMES})\\b).)*))`,
  'gs',
);

/** 解析 /goal 命令；非 /goal 返回 null。flag 缺省即 undefined。 */
export function parseGoalCommand(raw: string): ParsedGoalCommand | null {
  const trimmed = raw.trim();
  const head = trimmed.match(/^\/goal\b\s*([\s\S]*)$/);
  if (!head) return null;

  const rest = head[1];
  const firstFlagIdx = rest.search(FIRST_FLAG_RE);
  const goal = (firstFlagIdx === -1 ? rest : rest.slice(0, firstFlagIdx)).trim();
  const flagSection = firstFlagIdx === -1 ? '' : rest.slice(firstFlagIdx);

  const result: ParsedGoalCommand = { goal };

  FLAG_VALUE_RE.lastIndex = 0;
  let fm: RegExpExecArray | null;
  while ((fm = FLAG_VALUE_RE.exec(flagSection)) !== null) {
    const name = fm[1];
    const value = (fm[3] ?? fm[4] ?? fm[5] ?? '').trim();
    if (name === 'verify') {
      result.verify = value || undefined;
    } else if (name === 'review') {
      result.review = value || undefined;
    } else if (name === 'max-turns') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) result.maxTurns = n;
    } else if (name === 'budget') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) result.budget = n;
    } else if (name === 'max-time') {
      // 收分钟，存 ms；与 token/轮次互补的时间兜底
      const mins = parseInt(value, 10);
      if (Number.isFinite(mins) && mins > 0) result.wallClockBudgetMs = mins * 60_000;
    }
  }

  return result;
}

export function buildDefaultGoalReview(goal: string, t: Translations = zh): string {
  return t.goalContract.defaultReviewPrefix + goal;
}

function cleanDraftField(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

export function buildGoalContractReview(draft: GoalComposerDraft, t: Translations = zh): string {
  const goal = draft.goal.trim();
  const copy = t.goalContract;
  const acceptance = cleanDraftField(draft.acceptance) ?? buildDefaultGoalReview(goal, t);
  const boundaries = cleanDraftField(draft.boundaries) ?? t.goalConfirm.defaultBoundaries;
  const pauseConditions = cleanDraftField(draft.pauseConditions) ?? t.goalConfirm.defaultPauseConditions;

  return [
    copy.header,
    `${copy.goalLinePrefix}${goal}`,
    `${copy.acceptanceLinePrefix}${acceptance}`,
    `${copy.boundariesLinePrefix}${boundaries}`,
    copy.evidenceLine,
    `${copy.pauseLinePrefix}${pauseConditions}`,
  ].join('\n');
}

export function goalComposerDraftToParsed(draft: GoalComposerDraft, t: Translations = zh): ParsedGoalCommand {
  const parsed: ParsedGoalCommand = {
    goal: draft.goal.trim(),
    review: buildGoalContractReview(draft, t),
  };
  const verify = cleanDraftField(draft.verify);
  if (verify) parsed.verify = verify;
  if (draft.maxTurns && Number.isFinite(draft.maxTurns) && draft.maxTurns > 0) {
    parsed.maxTurns = Math.floor(draft.maxTurns);
  }
  if (draft.budget && Number.isFinite(draft.budget) && draft.budget > 0) {
    parsed.budget = Math.floor(draft.budget);
  }
  if (draft.wallClockMinutes && Number.isFinite(draft.wallClockMinutes) && draft.wallClockMinutes > 0) {
    parsed.wallClockBudgetMs = Math.floor(draft.wallClockMinutes) * 60_000;
  }
  return parsed;
}

export function normalizeGoalCommand(parsed: ParsedGoalCommand, t: Translations = zh): ParsedGoalCommand {
  if (!parsed.goal || parsed.verify || parsed.review) {
    return parsed;
  }
  return {
    ...parsed,
    review: buildDefaultGoalReview(parsed.goal, t),
  };
}

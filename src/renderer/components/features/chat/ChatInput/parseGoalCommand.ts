// ============================================================================
// /goal 斜杠命令解析
//   /goal <目标文本> [--verify "<shell 命令>"] [--review "<软条件>"]
//                    [--max-turns <N>] [--budget <N>]
// verify/review 值可用单/双引号包裹（含空格时必须），或裸写（取到下一个 flag 前）。
// 解析结果交给 ChatInput 校验 goal 非空；未显式提供 verify/review 时走默认软目标评审。
// ============================================================================

export interface ParsedGoalCommand {
  goal: string;
  verify?: string;
  review?: string;
  maxTurns?: number;
  budget?: number;
}

export interface GoalComposerDraft {
  goal: string;
  verify?: string;
  acceptance?: string;
  boundaries?: string;
  pauseConditions?: string;
  maxTurns?: number;
  budget?: number;
}

/** 是否是 /goal 命令（用于 handleSubmit 提前拦截判断）。 */
export function isGoalCommand(raw: string): boolean {
  return /^\/goal\b/.test(raw.trim());
}

const FLAG_NAMES = 'verify|review|max-turns|budget';
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
    }
  }

  return result;
}

export function buildDefaultGoalReview(goal: string): string {
  return `结果满足目标描述中的全部要求，且没有明显未完成项：${goal}`;
}

function cleanDraftField(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

export function buildGoalContractReview(draft: GoalComposerDraft): string {
  const goal = draft.goal.trim();
  const acceptance = cleanDraftField(draft.acceptance) ?? buildDefaultGoalReview(goal);
  const boundaries = cleanDraftField(draft.boundaries) ?? '只修改与目标直接相关的文件和配置，避免无关重构、无关功能和破坏性操作。';
  const pauseConditions = cleanDraftField(draft.pauseConditions) ?? '需要凭证、付费、生产数据、破坏性操作、范围扩大，或连续 2 轮验证失败且没有新证据时暂停。';

  return [
    '目标合同：',
    `目标：${goal}`,
    `验收：${acceptance}`,
    `边界：${boundaries}`,
    '证据：完成前说明运行过的命令、检查过的文件、截图或日志证据；没有证据的要求按未完成处理。',
    `暂停条件：${pauseConditions}`,
  ].join('\n');
}

export function goalComposerDraftToParsed(draft: GoalComposerDraft): ParsedGoalCommand {
  const parsed: ParsedGoalCommand = {
    goal: draft.goal.trim(),
    review: buildGoalContractReview(draft),
  };
  const verify = cleanDraftField(draft.verify);
  if (verify) parsed.verify = verify;
  if (draft.maxTurns && Number.isFinite(draft.maxTurns) && draft.maxTurns > 0) {
    parsed.maxTurns = Math.floor(draft.maxTurns);
  }
  if (draft.budget && Number.isFinite(draft.budget) && draft.budget > 0) {
    parsed.budget = Math.floor(draft.budget);
  }
  return parsed;
}

export function normalizeGoalCommand(parsed: ParsedGoalCommand): ParsedGoalCommand {
  if (!parsed.goal || parsed.verify || parsed.review) {
    return parsed;
  }
  return {
    ...parsed,
    review: buildDefaultGoalReview(parsed.goal),
  };
}

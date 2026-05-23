// ============================================================================
// /goal 斜杠命令解析
//   /goal <目标文本> [--verify "<shell 命令>"] [--review "<软条件>"]
//                    [--max-turns <N>] [--budget <N>]
// verify/review 值可用单/双引号包裹（含空格时必须），或裸写（取到下一个 flag 前）。
// 解析结果交给 ChatInput 校验（goal 非空 + verify/review 至少一个）后随 envelope.options.goal 发出。
// ============================================================================

export interface ParsedGoalCommand {
  goal: string;
  verify?: string;
  review?: string;
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

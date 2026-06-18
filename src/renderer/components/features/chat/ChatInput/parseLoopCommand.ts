// ============================================================================
// /loop 斜杠命令解析
//   /loop [interval] <prompt> [--max-turns <N>] [--until "<软停止条件>"] [--handoff "<下一步提示词>"] [--budget <N>]
//
// - interval: 形如 30s / 5m / 2h / 1h30m（h/m/s 可组合，需带单位）。
//   缺省 = 模型自定步调：每轮结束由模型自己决定下次延迟，而非固定间隔。
// - prompt: 循环要反复执行的主体文本；空 prompt 交由 submit 层提示用法。
// - until: 软停止条件的自然语言描述（满足即停）。
// - budget: token 预算上限；max-turns: 最大轮次上限。
// 与 parseGoalCommand 的 flag 解析约定保持一致（引号包裹或裸值取到下一个 flag 前）。
// ============================================================================

export interface ParsedLoopCommand {
  prompt: string;
  /** 固定间隔（毫秒）。缺省表示模型自定步调。 */
  intervalMs?: number;
  maxTurns?: number;
  until?: string;
  handoffPrompt?: string;
  budget?: number;
}

/** 是否是 /loop 命令（用于 handleSubmit 提前拦截判断）。 */
export function isLoopCommand(raw: string): boolean {
  return /^\/loop\b/.test(raw.trim());
}

const FLAG_NAMES = 'max-turns|until|handoff|then|budget';
const FIRST_FLAG_RE = new RegExp(`(^|\\s)--(?:${FLAG_NAMES})\\b`);
const FLAG_VALUE_RE = new RegExp(
  `--(${FLAG_NAMES})\\s+("([^"]*)"|'([^']*)'|((?:(?!\\s--(?:${FLAG_NAMES})\\b).)*))`,
  'gs',
);

// 纯 duration token：h/m/s 段各自可选但必须带单位，且至少出现一段（按 h→m→s 顺序）。
const DURATION_RE = /^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/;

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;

/** 把 30s / 5m / 1h30m 解析成毫秒；非合法 duration 返回 null。 */
function parseDurationMs(token: string): number | null {
  if (!token || !DURATION_RE.test(token)) return null;
  const h = /(\d+)h/.exec(token);
  const m = /(\d+)m/.exec(token);
  const s = /(\d+)s/.exec(token);
  if (!h && !m && !s) return null;
  const ms =
    (h ? parseInt(h[1], 10) * MS_PER_HOUR : 0) +
    (m ? parseInt(m[1], 10) * MS_PER_MINUTE : 0) +
    (s ? parseInt(s[1], 10) * MS_PER_SECOND : 0);
  return ms > 0 ? ms : null;
}

/** 解析 /loop 命令；非 /loop 返回 null。 */
export function parseLoopCommand(raw: string): ParsedLoopCommand | null {
  const trimmed = raw.trim();
  const head = trimmed.match(/^\/loop\b\s*([\s\S]*)$/);
  if (!head) return null;

  const rest = head[1];
  const firstFlagIdx = rest.search(FIRST_FLAG_RE);
  const body = (firstFlagIdx === -1 ? rest : rest.slice(0, firstFlagIdx)).trim();
  const flagSection = firstFlagIdx === -1 ? '' : rest.slice(firstFlagIdx);

  // 抽取可选的前导 interval（仅当第一个 token 是合法 duration 时）。
  let prompt = body;
  let intervalMs: number | undefined;
  const spaceIdx = body.search(/\s/);
  const firstToken = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
  const maybeMs = parseDurationMs(firstToken);
  if (maybeMs !== null) {
    intervalMs = maybeMs;
    prompt = spaceIdx === -1 ? '' : body.slice(spaceIdx).trim();
  }

  const result: ParsedLoopCommand = { prompt };
  if (intervalMs !== undefined) result.intervalMs = intervalMs;

  FLAG_VALUE_RE.lastIndex = 0;
  let fm: RegExpExecArray | null;
  while ((fm = FLAG_VALUE_RE.exec(flagSection)) !== null) {
    const name = fm[1];
    const value = (fm[3] ?? fm[4] ?? fm[5] ?? '').trim();
    if (name === 'until') {
      if (value) result.until = value;
    } else if (name === 'handoff' || name === 'then') {
      if (value) result.handoffPrompt = value;
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

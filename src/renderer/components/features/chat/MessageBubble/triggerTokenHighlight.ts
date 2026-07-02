// ============================================================================
// 核心功能触发词着色（用户消息气泡内）
// @neo / /goal / /workflow 这类消息开头的功能触发词用颜色体现差异：
// Neo 用翠绿（与回复侧 Neo 身份标识同色系），workflow 用彩虹渐变，goal 用琥珀。
// 只匹配消息开头的完整 token——正文中途提到的词不是触发词，不上色。
// ============================================================================

export type TriggerTokenKind = 'neo' | 'goal' | 'workflow';

export interface ParsedTriggerToken {
  kind: TriggerTokenKind;
  /** 用户实际输入的 token 原文（保留大小写，如 `@Neo`）。 */
  token: string;
  /** token 之前的空白（原样保留，保证气泡文本逐字符不变）。 */
  prefix: string;
  /** token 之后的全部内容（含紧随的空格，原样保留）。 */
  rest: string;
  className: string;
}

const TRIGGER_TOKEN_RULES: Array<{ kind: TriggerTokenKind; pattern: RegExp; className: string }> = [
  {
    kind: 'neo',
    pattern: /^@neo(?=\s|$)/i,
    className: 'font-medium text-emerald-300',
  },
  {
    kind: 'goal',
    pattern: /^\/goal(?=\s|$)/,
    className: 'font-medium text-amber-300',
  },
  {
    kind: 'workflow',
    // 彩虹渐变文字（Tailwind 单 via 限制，用 arbitrary linear-gradient）
    pattern: /^\/workflow(?=\s|$)/,
    className: 'font-semibold bg-[linear-gradient(90deg,#f87171,#fbbf24,#34d399,#38bdf8,#a78bfa)] bg-clip-text text-transparent',
  },
];

/**
 * @neo 消息落库的正文是剥掉前缀的任务文本（它同时是模型 prompt），
 * 渲染时把用户原本输入的 `@neo ` 补回来展示——live 与重启后视觉一致，着色也有得可染。
 */
export function restoreNeoTagTokenForDisplay(content: string, isNeoTagMessage: boolean): string {
  if (!isNeoTagMessage || !content) return content;
  if (/^\s*@neo(?:\s|$)/i.test(content)) return content;
  return `@neo ${content}`;
}

export function parseLeadingTriggerToken(content: string): ParsedTriggerToken | null {
  const prefixMatch = content.match(/^\s*/);
  const prefix = prefixMatch?.[0] ?? '';
  const body = content.slice(prefix.length);

  for (const rule of TRIGGER_TOKEN_RULES) {
    const match = body.match(rule.pattern);
    if (!match) continue;
    const token = match[0];
    return {
      kind: rule.kind,
      token,
      prefix,
      rest: body.slice(token.length),
      className: rule.className,
    };
  }
  return null;
}

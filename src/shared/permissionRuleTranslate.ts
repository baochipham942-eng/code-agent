// ============================================================================
// permissionRuleTranslate —— 一句话权限规则翻译（N-PERM-NL-RULES-K1）共享层
// ----------------------------------------------------------------------------
// 设计基调 B2：模型只产结构化草稿（draft），人话复述由代码从草稿生成（describeRule），
// 例子由确定性匹配器验证（host 侧 validateDraft，见 permissions/permissionRuleDraft.ts）。
// 运行时判定仍是 policyEngine 的确定性规则，本模块不参与 evaluate。
//
// 文案放在本共享模块（cronHumanize.ts 先例：host 生成的用户话术 + renderer 展示共用
// 一份，不进大 settings i18n 文件）；renderer 周边静态文案在 renderer/i18n/permissionRuleNl.ts。
// ============================================================================

import { TOOL_SPECIFIER_PATTERN, TOOL_SPECIFIER_TYPES } from './permissionRuleSyntax';

/** 行为档：与用户规则三列表一一对应（engine 里 ask = prompt）。 */
export type NlRuleBehavior = 'allow' | 'ask' | 'deny';

/** 模型产出的草稿（翻译结果），未经确定性校验前的原始形状。 */
export interface PermissionRuleDraft {
  /** 工具名，须出自真实工具目录（MCP 工具为 mcp__server__tool） */
  tool: string;
  /** Tool(pattern) 的括号模式；只有接受 command/path 指定的工具才能带 */
  pattern?: string;
  behavior: NlRuleBehavior;
  /** hit = 会被这条规则命中；miss = 明确不会命中。用于确定性反证与确认卡示例 */
  examples: { hit: readonly string[]; miss: readonly string[] };
}

/** 与已保存规则的冲突：更严的那条会生效（policyEngine deny > ask > allow）。 */
export interface PermissionTranslateConflict {
  /** 已存在的更严规则原文 */
  existingRule: string;
  /** 该已存规则的行为档 */
  existingBehavior: NlRuleBehavior;
  /** 两条并存时实际生效的档（= 更严的那档），确认卡默认切到它 */
  effectiveBehavior: NlRuleBehavior;
}

/**
 * 翻译域通道的返回载荷。status：
 *  - ok           可翻译，rule/restatement/examples 就绪，等待用户确认
 *  - unrecognized 没法可靠识别（主观/模糊/对不上具体工具），不给确认按钮
 *  - protected    allow 会盖到受保护动作上，拒绝自动放行；只提供 ask/deny
 */
export interface PermissionTranslateResult {
  status: 'ok' | 'unrecognized' | 'protected';
  /** 模型原始草稿（证据留档用） */
  draft?: PermissionRuleDraft;
  /** 规范化后的规则串（status ok 时给出），如 Bash(rm *) */
  rule?: string;
  /** 生效行为档（ok 时为草稿档；有冲突时已被上调为更严档） */
  behavior?: NlRuleBehavior;
  /** 代码生成的人话复述（ok / protected 给出） */
  restatement?: string;
  /** 面向用户的中文说明（unrecognized / protected / 冲突提示） */
  reasonText?: string;
  conflict?: PermissionTranslateConflict;
  /** 确认卡要展示的已验证示例 */
  examples?: { hit: readonly string[]; miss: readonly string[] };
}

/** 翻译器注入面：脚本可以用 GLM 直连实现替换默认 ModelRouter 通道。 */
export type TranslatorChatFn = (
  messages: Array<{ role: string; content: string }>,
) => Promise<string>;

// ----------------------------------------------------------------------------
// 中文话术（唯一源：确认卡、已存规则白话对照、host 返回的 reasonText 共用）
// ----------------------------------------------------------------------------

export const NL_RULE_TEXT = {
  behavior: {
    allow: '直接做',
    ask: '先问我',
    deny: '永不',
  },
  behaviorPhrase: {
    allow: '直接执行，不再询问',
    ask: '先问你',
    deny: '一律禁止',
  },
  unrecognizedReason: '这条我没法可靠识别。我能识别的是：具体的终端命令（比如 rm 开头的命令）、文件路径（比如 .env 文件）、或某个具体工具（比如发邮件）。可以照「删文件之前先问我」这样，用一句提到具体命令、文件或工具的话改写一下。',
  protectedReason: '这类操作我不会帮你设成自动放行。可以改成「先问我」或「永不」。',
  modelUnavailable: '现在没法翻译这句话（翻译服务暂时不可用）。已保存的规则不受影响，稍后再试。',
  parseError: '翻译返回的格式不对，请重试或换个说法。',
  conflictNote: (existingRule: string, effective: NlRuleBehavior): string => (
    `已有一条更严的规则 ${existingRule}，两条同时存在时更严的那条会生效，这里默认按「${NL_RULE_TEXT.behavior[effective]}」保存。`
  ),
} as const;

/** 工具 → 用户话术。带指定的七个核心工具 + 高频具名工具，其余回退「使用工具 X」。 */
const TOOL_ZH: Record<string, string> = {
  Bash: '用终端运行',
  Edit: '改动',
  Write: '写入',
  Read: '读取',
  Glob: '搜索文件',
  Grep: '搜索文件内容',
  ListDirectory: '列出',
  mail_send: '发邮件',
  mail_draft: '写邮件草稿',
  mail: '读邮件',
  WebFetch: '访问网页',
  WebSearch: '搜索网页',
};

function toolPhrase(toolName: string): string {
  return TOOL_ZH[toolName] ?? `使用工具 ${toolName}`;
}

/**
 * 通配模式 → 中文范围短语。
 * `rm *` → “rm 开头的命令”；`.env*` → “.env 开头的文件”；`src/**` → “src 下的文件”；
 * `*` → “任何命令”；其余 → “匹配 X 的命令”。
 * 只做这几类确定性变换，变不出人话的原样带出模式串，不瞎猜语义。
 */
function patternPhrase(pattern: string, noun: '命令' | '文件'): string {
  if (pattern === '*' || pattern === '**') return `任何${noun}`;
  const hasGlob = /[*?[\]{}!]/.test(pattern);
  // 完全不带通配符 = 精确匹配这一条
  if (!hasGlob) return noun === '命令' ? `${pattern} 这条${noun}` : `${pattern} 这个${noun}`;
  // 目录形 `src/**`：目录下所有东西
  const underDir = /^(.+\/)\*\*$/.exec(pattern)?.[1];
  if (underDir && !/[*?[\]{}!]/.test(underDir)) {
    return `${underDir.replace(/\/+$/, '')} 下的${noun}`;
  }
  // 前缀形 `rm *` / `.env*`：去掉结尾通配符后无其他元字符才是纯前缀
  const prefix = /^(.+)[*]$/.exec(pattern)?.[1];
  if (prefix && !/[*?[\]{}!]/.test(prefix)) {
    return `${prefix.replace(/[\s/]+$/, '')} 开头的${noun}`;
  }
  return `匹配 ${pattern} 的${noun}`;
}

/**
 * 规则串 → 人话复述（代码生成，不经过模型）。
 * describeRule('Bash(rm *)', 'ask') === '用终端运行 rm 开头的命令时 → 先问你'。
 * 裸工具名（无括号）按整工具面复述；不认识的形状原样带出规则串。
 */
export function describeRule(rule: string, behavior: NlRuleBehavior): string {
  const behaviorPhrase = NL_RULE_TEXT.behaviorPhrase[behavior];
  const match = TOOL_SPECIFIER_PATTERN.exec(rule);
  if (!match) {
    const specifierType = TOOL_SPECIFIER_TYPES[rule];
    const scope = specifierType === 'command' ? '任何命令' : specifierType === 'path' ? '任何文件' : '';
    return `${toolPhrase(rule)}${scope}时 → ${behaviorPhrase}`;
  }
  const [, toolName, rawPattern] = match;
  const pattern = rawPattern.trim();
  const noun: '命令' | '文件' = toolName === 'Bash' ? '命令' : '文件';
  return `${toolPhrase(toolName)} ${patternPhrase(pattern, noun)}时 → ${behaviorPhrase}`;
}

/** 草稿 → 规范化规则串（带模式时 Tool(pattern)，否则裸工具名）。 */
export function buildRuleString(draft: Pick<PermissionRuleDraft, 'tool' | 'pattern'>): string {
  const pattern = draft.pattern?.trim();
  return pattern ? `${draft.tool}(${pattern})` : draft.tool;
}

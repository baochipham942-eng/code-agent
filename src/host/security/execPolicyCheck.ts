// ============================================================================
// Exec Policy Check - exec-policy.json 离线校验（neo policy check 的核心逻辑）
// ============================================================================
//
// 纯函数模块：无 IO、无日志、无副作用，可直接用于 CI pre-gate。
//
// 冲突分类（conflict taxonomy）——match() 是最长前缀匹配，shadowing 语义以此为准：
//
//   duplicate-pattern   完全相同的 pattern 出现多次。同长匹配先出现者胜出，
//                       后者恒不可达：decision 相同 → warning（冗余）；
//                       decision 不同 → error（文件意图有歧义）。
//   shadow-escalation   短 pattern 是长 pattern 的严格前缀，且短规则为 forbidden
//                       而长规则更宽松（allow 或 prompt）。最长前缀匹配下长规则在其
//                       子树内恒胜出——一条 forbidden 硬边界被悄悄穿透 → error。
//                       反方向均不算冲突：长规则更严格是正常分层；
//                       宽规则为 prompt、窄规则为 allow 是 learnFromApproval 的
//                       设计用法（prompt 本就是默认态，显式放行子树不是穿透）。
//   banned-prefix-allow  pattern[0] 命中 BANNED_PREFIXES 且 decision 为 allow。
//                       learnFromApproval 永远拒绝学习这些 prefix；手写的 allow
//                       规则会绕过这层防护 → error。（prompt/forbidden 不算违规。）

import {
  BANNED_PREFIXES,
  matchPolicyRule,
  tokenizePolicyCommand,
  type PolicyDecision,
  type PrefixRule,
} from './execPolicy';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

type PolicyIssueCode =
  | 'invalid-json'
  | 'invalid-schema'
  | 'duplicate-pattern'
  | 'shadow-escalation'
  | 'banned-prefix-allow';

export interface PolicyIssue {
  code: PolicyIssueCode;
  severity: 'error' | 'warning';
  message: string;
  ruleIndexes?: number[];
}

/** 示例命令 + 期望决策（policy 文件 examples 数组或 CLI --expect 的同一形态） */
export interface PolicyExample {
  command: string;
  expect: PolicyDecision;
}

export interface PolicyExampleResult extends PolicyExample {
  /** 实际匹配结果；null = 没有任何规则命中 */
  actual: PolicyDecision | null;
  pass: boolean;
}

export interface PolicyParseResult {
  /** 结构合法的规则（语法错误的条目被剔除，不进入冲突/示例检查） */
  rules: PrefixRule[];
  examples: PolicyExample[];
  issues: PolicyIssue[];
}

export interface PolicyExplanation {
  command: string;
  tokens: string[];
  matched: PrefixRule | null;
  /** null = 未命中任何规则（走常规权限流程） */
  decision: PolicyDecision | null;
  reason: string;
}

// ----------------------------------------------------------------------------
// Syntax validation
// ----------------------------------------------------------------------------

const VALID_DECISIONS: readonly PolicyDecision[] = ['allow', 'prompt', 'forbidden'];
const VALID_SOURCES = ['user', 'builtin'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidDecision(value: unknown): value is PolicyDecision {
  return typeof value === 'string' && (VALID_DECISIONS as readonly string[]).includes(value);
}

/** 校验单条 rule 的结构；合法则返回类型化规则，否则返回 null 并记录 issue。 */
function validateRuleShape(raw: unknown, index: number, issues: PolicyIssue[]): PrefixRule | null {
  const where = `rules[${index}]`;
  if (!isRecord(raw)) {
    issues.push({ code: 'invalid-schema', severity: 'error', message: `${where} 必须是对象`, ruleIndexes: [index] });
    return null;
  }

  let ok = true;
  const fail = (message: string): void => {
    issues.push({ code: 'invalid-schema', severity: 'error', message: `${where}: ${message}`, ruleIndexes: [index] });
    ok = false;
  };

  if (!Array.isArray(raw.pattern) || raw.pattern.length === 0) {
    fail('pattern 必须是非空字符串数组');
  } else if (raw.pattern.some((t) => typeof t !== 'string' || t.trim() === '')) {
    fail('pattern 含有空 token（所有元素必须是非空字符串）');
  }
  if (!isValidDecision(raw.decision)) {
    fail(`decision 无效: ${JSON.stringify(raw.decision)}（允许值: allow|prompt|forbidden）`);
  }
  if (raw.source !== undefined && !(VALID_SOURCES as readonly unknown[]).includes(raw.source)) {
    fail(`source 无效: ${JSON.stringify(raw.source)}（允许值: user|builtin）`);
  }
  if (raw.createdAt !== undefined && (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt))) {
    fail('createdAt 必须是有限数字（epoch ms）');
  }
  if (!ok) return null;

  return {
    pattern: raw.pattern as string[],
    decision: raw.decision as PolicyDecision,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    source: (raw.source as PrefixRule['source'] | undefined) ?? 'user',
  };
}

function validateExampleShape(raw: unknown, index: number, issues: PolicyIssue[]): PolicyExample | null {
  const where = `examples[${index}]`;
  if (!isRecord(raw)) {
    issues.push({ code: 'invalid-schema', severity: 'error', message: `${where} 必须是对象` });
    return null;
  }
  if (typeof raw.command !== 'string' || raw.command.trim() === '') {
    issues.push({ code: 'invalid-schema', severity: 'error', message: `${where}.command 必须是非空字符串` });
    return null;
  }
  if (!isValidDecision(raw.expect)) {
    issues.push({
      code: 'invalid-schema',
      severity: 'error',
      message: `${where}.expect 无效: ${JSON.stringify(raw.expect)}（允许值: allow|prompt|forbidden）`,
    });
    return null;
  }
  return { command: raw.command, expect: raw.expect };
}

/**
 * 解析并校验 exec-policy.json 文本。
 * 收集全部问题（不 throw）；结构合法的规则/示例照常返回，供冲突与示例检查继续使用。
 */
export function parseExecPolicy(raw: string): PolicyParseResult {
  const issues: PolicyIssue[] = [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    issues.push({
      code: 'invalid-json',
      severity: 'error',
      message: `不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { rules: [], examples: [], issues };
  }

  if (!isRecord(data)) {
    issues.push({ code: 'invalid-schema', severity: 'error', message: '顶层必须是对象 { version, rules, examples? }' });
    return { rules: [], examples: [], issues };
  }
  if (data.version !== 1) {
    issues.push({ code: 'invalid-schema', severity: 'error', message: `version 必须是 1，实际: ${JSON.stringify(data.version)}` });
  }

  const rules: PrefixRule[] = [];
  if (!Array.isArray(data.rules)) {
    issues.push({ code: 'invalid-schema', severity: 'error', message: 'rules 必须是数组' });
  } else {
    for (const [i, rawRule] of (data.rules as unknown[]).entries()) {
      const rule = validateRuleShape(rawRule, i, issues);
      if (rule) rules.push(rule);
    }
  }

  const examples: PolicyExample[] = [];
  if (data.examples !== undefined) {
    if (!Array.isArray(data.examples)) {
      issues.push({ code: 'invalid-schema', severity: 'error', message: 'examples 必须是数组（{ command, expect }）' });
    } else {
      for (const [i, rawExample] of (data.examples as unknown[]).entries()) {
        const example = validateExampleShape(rawExample, i, issues);
        if (example) examples.push(example);
      }
    }
  }

  return { rules, examples, issues };
}

// ----------------------------------------------------------------------------
// Conflict detection
// ----------------------------------------------------------------------------

function patternKey(pattern: readonly string[]): string {
  // NUL 分隔：避免 token 本身含空格等字符时不同 pattern 拼出相同 key
  return pattern.join('\0');
}

function formatPattern(pattern: readonly string[]): string {
  return `[${pattern.map((t) => JSON.stringify(t)).join(', ')}]`;
}

function isStrictPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
  if (shorter.length >= longer.length) return false;
  return shorter.every((token, i) => token === longer[i]);
}

/** 冲突检测（分类见文件头注释）。 */
export function findPolicyConflicts(rules: readonly PrefixRule[]): PolicyIssue[] {
  const issues: PolicyIssue[] = [];

  // 1) duplicate-pattern
  const byPattern = new Map<string, number[]>();
  for (const [i, rule] of rules.entries()) {
    const key = patternKey(rule.pattern);
    const group = byPattern.get(key);
    if (group) group.push(i);
    else byPattern.set(key, [i]);
  }
  for (const indexes of byPattern.values()) {
    if (indexes.length < 2) continue;
    const first = rules[indexes[0] as number] as PrefixRule;
    const sameDecision = indexes.every((i) => (rules[i] as PrefixRule).decision === first.decision);
    issues.push({
      code: 'duplicate-pattern',
      severity: sameDecision ? 'warning' : 'error',
      message:
        `规则 ${indexes.join(', ')} 的 pattern 完全相同 ${formatPattern(first.pattern)}` +
        (sameDecision
          ? `（都是 ${first.decision}，后者恒不可达，属冗余）`
          : `（decision 不一致，同长匹配先出现者胜出，文件意图有歧义）`),
      ruleIndexes: indexes,
    });
  }

  // 2) shadow-escalation + 3) banned-prefix-allow
  for (const [i, rule] of rules.entries()) {
    if (rule.decision === 'allow' && BANNED_PREFIXES.has(rule.pattern[0] ?? '')) {
      issues.push({
        code: 'banned-prefix-allow',
        severity: 'error',
        message:
          `规则 ${i} ${formatPattern(rule.pattern)} 以被禁 prefix "${rule.pattern[0] ?? ''}" 放行命令` +
          '（learnFromApproval 永远不会学习这类 prefix；手写 allow 会绕过防护）',
        ruleIndexes: [i],
      });
    }
    if (rule.decision !== 'forbidden') continue;
    for (const [j, other] of rules.entries()) {
      if (i === j) continue;
      // other 是更长的规则，rule(forbidden) 是它的严格前缀
      if (!isStrictPrefix(rule.pattern, other.pattern)) continue;
      if (other.decision !== 'forbidden') {
        issues.push({
          code: 'shadow-escalation',
          severity: 'error',
          message:
            `规则 ${j} ${formatPattern(other.pattern)} → ${other.decision} 放宽了其前缀规则 ${i} ` +
            `${formatPattern(rule.pattern)} → forbidden（最长前缀匹配下规则 ${j} 在其子树内恒胜出，` +
            `规则 ${i} 的 forbidden 意图被穿透）`,
          ruleIndexes: [i, j],
        });
      }
    }
  }

  return issues;
}

// ----------------------------------------------------------------------------
// Examples / explain
// ----------------------------------------------------------------------------

/** 逐条跑示例命令：actual 为 null（无规则命中）时不等于任何期望决策。 */
export function checkPolicyExamples(
  rules: readonly PrefixRule[],
  examples: readonly PolicyExample[],
): PolicyExampleResult[] {
  return examples.map((example) => {
    const actual = matchPolicyRule(rules, example.command)?.decision ?? null;
    return { ...example, actual, pass: actual === example.expect };
  });
}

/** 解释一条命令的匹配结果：命中了哪条规则、为什么。 */
export function explainPolicyCommand(rules: readonly PrefixRule[], command: string): PolicyExplanation {
  const tokens = tokenizePolicyCommand(command);
  if (tokens.length === 0) {
    return {
      command,
      tokens,
      matched: null,
      decision: null,
      reason: '命令无法静态解析（canonicalize 失败或为空）→ 不命中任何规则，走常规权限流程',
    };
  }
  const matched = matchPolicyRule(rules, command);
  if (!matched) {
    return {
      command,
      tokens,
      matched: null,
      decision: null,
      reason: '没有规则匹配 → match() 返回 null，走常规权限流程',
    };
  }
  return {
    command,
    tokens,
    matched,
    decision: matched.decision,
    reason: `最长前缀命中规则 ${formatPattern(matched.pattern)}（长度 ${matched.pattern.length}，source: ${matched.source}）→ ${matched.decision}`,
  };
}

// User permission rule syntax shared by the settings editor and the policy engine.
// One table and one Tool(pattern) shape, so a line the editor accepts is a line the engine can load.

import picomatch from 'picomatch';
import type { NlRuleBehavior } from './permissionRuleTranslate';
import type { NlPermissionRuleEntry } from './contract/settings';

/** Tools whose Tool(pattern) specifier is a command or a path. Every other tool is name-only. */
export const TOOL_SPECIFIER_TYPES: Record<string, 'command' | 'path'> = {
  Bash: 'command',
  Edit: 'path',
  Write: 'path',
  Read: 'path',
  Glob: 'path',
  Grep: 'path',
  ListDirectory: 'path',
};

/** `Tool(pattern)` with a non-empty pattern. The engine parser does not trim or fold case. */
export const TOOL_SPECIFIER_PATTERN = /^(\w+)\((.+)\)$/;

/** Picomatch options the engine uses for command and path specifiers. */
export const PERMISSION_RULE_GLOB_OPTIONS = { bash: true, dot: true } as const;

// ponytail: the probe set is finite, so an exotic glob that misses one probe passes.
// `!(zzz)` does not match `./a/b --c=/d` under these options, same as a lone `*`.
const BASH_ALLOW_ALL_PROBES = [
  'ls',
  'x',
  'rm -rf /',
  'cat /etc/passwd',
  './a/b --c=/d',
  'git status && echo /',
  'x'.repeat(300),
];

type UserPermissionRuleList = 'allow' | 'ask' | 'deny';

type UserPermissionRuleVerdict =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'malformed' | 'specifier_not_supported' | 'allow_all_bash' };

function isStarOnly(specifier: string): boolean {
  return specifier.length === 0 || /^\*+$/.test(specifier);
}

function matchesEveryBashProbe(specifier: string): boolean {
  return BASH_ALLOW_ALL_PROBES.every((probe) => (
    picomatch.isMatch(probe, specifier, PERMISSION_RULE_GLOB_OPTIONS)
  ));
}

/**
 * A rule is ok when it is non-empty after trim and is either a bare tool name
 * or `Tool(pattern)` whose tool actually takes a command or path specifier.
 * On the allow list, a rule equivalent to "allow every Bash command" is rejected.
 */
export function validateUserPermissionRule(
  rule: string,
  list: UserPermissionRuleList,
): UserPermissionRuleVerdict {
  const trimmed = rule.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  // MCP names are mcp__${serverName}__${tool.name} and keep '-' and '.' (mcpToolRegistry).
  if (/^[\w.-]+$/.test(trimmed)) {
    if (list === 'allow' && trimmed.toLowerCase() === 'bash') {
      return { ok: false, reason: 'allow_all_bash' };
    }
    return { ok: true };
  }

  const match = TOOL_SPECIFIER_PATTERN.exec(trimmed);
  if (!match) return { ok: false, reason: 'malformed' };

  const toolName = match[1];
  const specifier = match[2].trim();
  const specifierType = TOOL_SPECIFIER_TYPES[toolName];
  if (specifierType !== 'command' && specifierType !== 'path') {
    return { ok: false, reason: 'specifier_not_supported' };
  }

  if (list === 'allow' && toolName.toLowerCase() === 'bash'
    && (isStarOnly(specifier) || matchesEveryBashProbe(specifier))) {
    return { ok: false, reason: 'allow_all_bash' };
  }

  return { ok: true };
}

/** True when both lists are arrays holding the same strings in the same order. */
function sameRuleList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((rule, i) => rule === b[i]);
}

/**
 * Throw on the first invalid deny/ask/allow entry a rule edit introduces.
 * Callers must do this before persisting. A list identical to `previous` is
 * echoed storage, not a rule edit, and is skipped: legacy rules older builds
 * accepted must not block unrelated settings writes (e.g. toggling dev mode);
 * those rules are skipped with a warning at PolicyEngine load time instead.
 */
export function assertValidUserPermissionRules(
  permissions: { deny?: readonly string[]; ask?: readonly string[]; allow?: readonly string[] } | null | undefined,
  previous?: { deny?: readonly string[]; ask?: readonly string[]; allow?: readonly string[] } | null,
): void {
  if (!permissions) return;
  for (const list of ['deny', 'ask', 'allow'] as const) {
    const rules = permissions[list];
    if (!rules) continue;
    if (previous && sameRuleList(rules, previous[list])) continue;
    for (const rule of rules) {
      if (typeof rule !== 'string' || !validateUserPermissionRule(rule, list).ok) {
        throw new Error(`Invalid permission rule in ${list}: ${JSON.stringify(rule)}`);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// N-PERM-NL-RULES-K2：permissions.nlRules 的形状与语义校验
// ----------------------------------------------------------------------------

const NL_BEHAVIORS: readonly NlRuleBehavior[] = ['allow', 'ask', 'deny', 'preapprove', 'handback'];

/** 短语通配元字符：触发短语是逐字子串匹配，出现通配符即坏输入。 */
const NL_PHRASE_WILDCARDS = /[*?[\]{}!]/;

/** preapprove 触发短语：2-12 字、非空、无通配符。 */
export function isValidNlPhrase(phrase: unknown): phrase is string {
  if (typeof phrase !== 'string') return false;
  const trimmed = phrase.trim();
  return trimmed.length >= 2 && trimmed.length <= 12 && !NL_PHRASE_WILDCARDS.test(trimmed);
}

function isNlRuleShapeValid(entry: unknown, index: number): { ok: true; value: NlPermissionRuleEntry } | { ok: false; reason: string } {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: `entry ${index} is not an object` };
  }
  const candidate = entry as Partial<NlPermissionRuleEntry>;
  if (!NL_BEHAVIORS.includes(candidate.behavior as NlRuleBehavior)) {
    return { ok: false, reason: `entry ${index} behavior invalid: ${JSON.stringify(candidate.behavior)}` };
  }
  const behavior = candidate.behavior as NlRuleBehavior;
  if (typeof candidate.rule !== 'string' || !candidate.rule.trim()) {
    return { ok: false, reason: `entry ${index} rule missing` };
  }
  // rule 本体仍走同一张 Tool(pattern) 语法表：allow/preapprove 按 allow 侧把关
  //（放行全部 Bash 这类形状不许进 preapprove），其余按 ask 侧（只查形状）。
  const list = behavior === 'allow' || behavior === 'preapprove' ? 'allow' : 'ask';
  const verdict = validateUserPermissionRule(candidate.rule, list);
  if (!verdict.ok) {
    return { ok: false, reason: `entry ${index} rule invalid (${verdict.reason}): ${candidate.rule}` };
  }
  if (candidate.roleId !== undefined) {
    if (typeof candidate.roleId !== 'string' || !candidate.roleId.trim() || candidate.roleId.length > 64) {
      return { ok: false, reason: `entry ${index} roleId invalid: ${JSON.stringify(candidate.roleId)}` };
    }
  }
  const phrases = candidate.phrases;
  if (behavior === 'preapprove') {
    if (!Array.isArray(phrases) || phrases.length < 1 || phrases.length > 5
        || !phrases.every((phrase) => isValidNlPhrase(phrase))) {
      return { ok: false, reason: `entry ${index} preapprove needs 1-5 phrases of 2-12 chars without wildcards` };
    }
  } else if (phrases !== undefined && (!Array.isArray(phrases) || phrases.length > 0)) {
    return { ok: false, reason: `entry ${index} phrases only allowed on preapprove` };
  }
  return { ok: true, value: candidate as NlPermissionRuleEntry };
}

/**
 * 校验单条 nlRules 条目（引擎装载与 UI 保存共用）。deny 一律由既有 user-deny 消费链
 * 硬拒的语义不在这里——这里只管形状与短语/角色规则。
 */
export function validateNlPermissionRuleEntry(entry: unknown): { ok: true; value: NlPermissionRuleEntry } | { ok: false; reason: string } {
  return isNlRuleShapeValid(entry, 0);
}

/**
 * Throw on the first invalid nlRules entry a rule edit introduces (callers must
 * run this before persisting). A list identical to `previous` is echoed storage,
 * not a rule edit, and is skipped — same contract as assertValidUserPermissionRules.
 * 逐字重复的条目也拒：同一条规则存两份只会让引擎装载出双份。
 */
export function assertValidNlPermissionRules(
  nlRules: readonly NlPermissionRuleEntry[] | undefined,
  previous?: readonly NlPermissionRuleEntry[] | undefined,
): void {
  if (!nlRules) return;
  if (previous && nlRules === previous) return;
  const seen = new Set<string>();
  nlRules.forEach((entry, index) => {
    const verdict = isNlRuleShapeValid(entry, index);
    if (!verdict.ok) throw new Error(`Invalid nlRules ${verdict.reason}`);
    const key = JSON.stringify([verdict.value.behavior, verdict.value.rule, verdict.value.roleId ?? null]);
    if (seen.has(key)) {
      throw new Error(`Invalid nlRules entry ${index}: duplicate of an earlier entry (${verdict.value.rule})`);
    }
    seen.add(key);
  });
}

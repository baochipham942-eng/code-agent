// ============================================================================
// permissionRuleDraft —— 一句话规则草稿的确定性校验（N-PERM-NL-RULES-K1）
// ----------------------------------------------------------------------------
// 模型只负责把中文句子变成 draft；draft 是否成立、例子是否真被匹配、allow 是否
// 盖到受保护动作、与已存规则谁更严，全部在这里用真实的解析器/匹配器
// （parseToolSpecifier / matchSpecifier / validateUserPermissionRule）机械判定。
// 判定失败只有两种出口：unrecognized（识别不了）或 protected（拒绝自动放行）。
// ============================================================================

import {
  buildRuleString,
  type NlRuleBehavior,
  type PermissionRuleDraft,
  type PermissionTranslateConflict,
} from '../../shared/permissionRuleTranslate';
import { validateUserPermissionRule } from '../../shared/permissionRuleSyntax';
import { normalizeToolName } from '../tools/toolNames';
import { matchSpecifier, parseToolSpecifier } from './specifierParser';

/** MCP 工具全名形态：mcp__server__tool，名字段允许字母数字下划线点横线。 */
const MCP_TOOL_NAME = /^mcp__[\w.-]+__[\w.-]+$/;

/** 工具目录条目的上限：条数异常的「目录」本身就是坏输入。 */
const MAX_CATALOG_SIZE = 4096;

export type DraftValidation =
  | { ok: true; rule: string; draft: PermissionRuleDraft }
  | { ok: false; reason: 'allow_all_bash' | 'shape' | 'tool_unknown' | 'rule_invalid' | 'example_mismatch'; detail?: string };

function isBehavior(value: unknown): value is NlRuleBehavior {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

/**
 * 确定性校验模型草稿：
 *  1. 形状：tool / behavior / examples 是正类型；
 *  2. tool 必须在真实工具目录里（MCP 工具按 mcp__server__tool 形态放行）；
 *  3. 规范化规则串过 validateUserPermissionRule（allow_all_bash 单列，翻译层映射 protected）；
 *  4. 带 pattern 的草稿必须自带 ≥1 hit / ≥1 miss 例子，且每条都被真实匹配器验证：
 *     hit 全命中、miss 全不命中（allow 按 allow 意图、ask/deny 按 restrict 意图）。
 */
export function validateDraft(
  draft: unknown,
  toolCatalog: readonly string[] | ReadonlySet<string>,
): DraftValidation {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return { ok: false, reason: 'shape', detail: 'draft is not an object' };
  }
  const candidate = draft as Partial<PermissionRuleDraft> & { examples?: Partial<PermissionRuleDraft['examples']> };
  if (typeof candidate.tool !== 'string' || candidate.tool.trim().length === 0) {
    return { ok: false, reason: 'shape', detail: 'tool missing' };
  }
  if (!isBehavior(candidate.behavior)) {
    return { ok: false, reason: 'shape', detail: 'behavior invalid' };
  }
  const hit = candidate.examples?.hit;
  const miss = candidate.examples?.miss;
  if (!isNonEmptyStringArray(hit) || !isNonEmptyStringArray(miss)) {
    return { ok: false, reason: 'shape', detail: 'examples must be non-empty string arrays' };
  }
  if (typeof candidate.pattern !== 'string' && candidate.pattern !== undefined) {
    return { ok: false, reason: 'shape', detail: 'pattern must be a string when present' };
  }

  const catalog = toolCatalog instanceof Set ? toolCatalog : new Set(toolCatalog);
  if (catalog.size === 0 || catalog.size > MAX_CATALOG_SIZE) {
    return { ok: false, reason: 'tool_unknown', detail: `suspicious tool catalog size ${catalog.size}` };
  }
  const rawTool = candidate.tool.trim();
  let tool = rawTool;
  if (!catalog.has(rawTool)) {
    if (MCP_TOOL_NAME.test(rawTool)) {
      tool = rawTool;
    } else {
      // 大小写折中：目录里只有大小写不同的同名工具时按目录拼写规范化
      const folded = [...catalog].find((name) => name.toLowerCase() === rawTool.toLowerCase());
      if (!folded) return { ok: false, reason: 'tool_unknown', detail: rawTool };
      tool = folded;
    }
  }

  const normalizedDraft: PermissionRuleDraft = {
    tool,
    ...(candidate.pattern !== undefined ? { pattern: candidate.pattern } : {}),
    behavior: candidate.behavior,
    examples: { hit, miss },
  };
  const rule = buildRuleString(normalizedDraft);
  const verdict = validateUserPermissionRule(rule, normalizedDraft.behavior);
  if (!verdict.ok) {
    return verdict.reason === 'allow_all_bash'
      ? { ok: false, reason: 'allow_all_bash' }
      : { ok: false, reason: 'rule_invalid', detail: verdict.reason };
  }

  const parsed = parseToolSpecifier(rule);
  if (parsed.specifier) {
    const intent = normalizedDraft.behavior === 'allow' ? 'allow' : 'restrict';
    for (const example of hit) {
      if (!matchSpecifier(parsed, example, intent)) {
        return { ok: false, reason: 'example_mismatch', detail: `hit example not matched: ${example}` };
      }
    }
    for (const example of miss) {
      if (matchSpecifier(parsed, example, intent)) {
        return { ok: false, reason: 'example_mismatch', detail: `miss example matched: ${example}` };
      }
    }
  }

  return { ok: true, rule, draft: normalizedDraft };
}

// ----------------------------------------------------------------------------
// 受保护动作探针：allow 草稿命中任一探针即拒绝自动放行（ask/deny 不受限）
// ----------------------------------------------------------------------------

/** 终端命令探针：sudo、删根、force push、读 SSH 密钥、改系统文件。 */
const PROTECTED_COMMAND_PROBES = [
  'sudo apt-get install build-essential',
  'sudo rm -rf /var/log/nginx',
  'rm -rf /',
  'rm -rf / --no-preserve-root',
  'rm -fr /etc',
  'git push --force origin main',
  'git push origin main --force',
  'cat ~/.ssh/id_rsa',
  'cp ~/.ssh/id_rsa /tmp/key',
  'echo 127.0.0.1 example.com > /etc/hosts',
] as const;

/** 路径探针：系统目录写入 + SSH 密钥读写（相对/家目录两种拼写都探）。 */
const PROTECTED_PATH_PROBES = [
  '/etc/hosts',
  '/etc/passwd',
  '/usr/bin/python3',
  '/usr/local/bin/agent-neo',
  '/bin/ls',
  '/System/Library/CoreServices/System',
  '.ssh/id_rsa',
  '/Users/demo/.ssh/id_rsa',
  '/Users/demo/.ssh/authorized_keys',
] as const;

/**
 * allow 规则是否盖到受保护动作。按 engine 对 allow 的同一匹配语义判定
 * （命令逐段全匹配）；裸 Bash allow 在 validateDraft 已被 allow_all_bash 拦下，
 * 这里只看带 pattern 的命令/路径规则。
 */
export function isProtectedAllowRule(rule: string): boolean {
  const parsed = parseToolSpecifier(rule);
  if (!parsed.specifier) return false;
  if (parsed.specifierType === 'command') {
    if (normalizeToolName(parsed.toolName) !== 'bash') return false;
    return PROTECTED_COMMAND_PROBES.some((probe) => matchSpecifier(parsed, probe, 'allow'));
  }
  if (parsed.specifierType === 'path') {
    return PROTECTED_PATH_PROBES.some((probe) => matchSpecifier(parsed, probe, 'allow'));
  }
  return false;
}

// ----------------------------------------------------------------------------
// 与已存规则的冲突：更严的赢（deny > ask > allow，与 policyEngine 判定序一致）
// ----------------------------------------------------------------------------

const BEHAVIOR_STRENGTH: Record<NlRuleBehavior, number> = { deny: 2, ask: 1, allow: 0 };

function stricter(a: NlRuleBehavior, b: NlRuleBehavior): NlRuleBehavior {
  return BEHAVIOR_STRENGTH[a] >= BEHAVIOR_STRENGTH[b] ? a : b;
}

/**
 * 新规则与已存规则同工具、且已存的更严规则盖住新规则全部 hit 例子时，报冲突：
 * 两条并存实际生效的是更严那条（engine deny > ask > allow）。
 */
export function resolveRuleConflict(
  rule: string,
  behavior: NlRuleBehavior,
  hitExamples: readonly string[],
  existingRules: { deny?: readonly string[]; ask?: readonly string[]; allow?: readonly string[] },
): PermissionTranslateConflict | undefined {
  const newTool = normalizeToolName(parseToolSpecifier(rule).toolName);
  const lists: Array<{ behavior: NlRuleBehavior; rules: readonly string[] | undefined }> = [
    { behavior: 'deny', rules: existingRules.deny },
    { behavior: 'ask', rules: existingRules.ask },
    { behavior: 'allow', rules: existingRules.allow },
  ];
  for (const { behavior: savedBehavior, rules } of lists) {
    if (!rules || BEHAVIOR_STRENGTH[savedBehavior] <= BEHAVIOR_STRENGTH[behavior]) continue;
    for (const savedRule of rules) {
      const parsed = parseToolSpecifier(savedRule);
      if (normalizeToolName(parsed.toolName) !== newTool) continue;
      const covers = hitExamples.every((example) => matchSpecifier(parsed, example, 'restrict'));
      if (covers) {
        return {
          existingRule: savedRule,
          existingBehavior: savedBehavior,
          effectiveBehavior: stricter(savedBehavior, behavior),
        };
      }
    }
  }
  return undefined;
}

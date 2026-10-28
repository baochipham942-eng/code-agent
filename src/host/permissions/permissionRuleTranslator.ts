// ============================================================================
// permissionRuleTranslator —— 一句话 → 权限规则草稿（N-PERM-NL-RULES-K1）
// ----------------------------------------------------------------------------
// 模型只做「中文句子 → 结构化草稿」一步；草稿的成立性、受保护动作拒绝、冲突取严、
// 人话复述全部是确定性代码。本函数不写任何设置——保存仍走用户确认后的 settings set。
//
// chat 可注入（默认走项目默认模型的 ModelRouter）：④ 的真跑脚本用 GLM 直连实现替换，
// 保证「这一条是真 glm-5.3 翻出来的」可以被独立复现。
// ============================================================================

import {
  NL_RULE_TEXT,
  buildRuleString,
  describeRule,
  type NlRuleBehavior,
  type PermissionRuleDraft,
  type PermissionTranslateResult,
  type TranslatorChatFn,
} from '../../shared/permissionRuleTranslate';
import { TOOL_SPECIFIER_TYPES } from '../../shared/permissionRuleSyntax';
import { MODEL_MAX_TOKENS } from '../../shared/constants';
import { ModelRouter } from '../model/modelRouter';
import { resolveSessionDefaultModelConfig } from '../services/core/sessionDefaults';
import { createLogger } from '../services/infra/logger';
import { parseToolSpecifier } from './specifierParser';
import { isProtectedAllowRule, resolveRuleConflict, validateDraft } from './permissionRuleDraft';

const logger = createLogger('NlRuleTranslator');

/** 模型返回的 JSON 无法解析（可重试的格式故障，区别于「识别不了」）。 */
export class PermissionTranslateParseError extends Error {
  constructor() {
    super('NL permission rule translation returned unparseable JSON');
    this.name = 'PermissionTranslateParseError';
  }
}

export interface TranslatePermissionOptions {
  /** 注入的模型通道；缺省走项目默认 provider/model */
  chat?: TranslatorChatFn;
  /** 工具名目录；缺省由调用方（ipc 层）给真实目录 */
  toolCatalog?: readonly string[];
  /** 已保存的用户规则，用于冲突取严 */
  existingRules?: { deny?: readonly string[]; ask?: readonly string[]; allow?: readonly string[] };
}

const defaultChat: TranslatorChatFn = async (messages) => {
  const { provider, model } = resolveSessionDefaultModelConfig();
  const response = await new ModelRouter().chat({
    provider,
    model,
    messages,
    maxTokens: MODEL_MAX_TOKENS.COMPACT,
  });
  return response.content ?? '';
};

/**
 * 系统提示：严格 JSON 草稿。高危放行照常产出 allow 草稿——拦不拦由确定性守卫决定
 * （isProtectedAllowRule），不靠模型自律，也不让模型替用户改主意。
 */
function buildSystemPrompt(toolCatalog: readonly string[]): string {
  const specifierTools = Object.entries(TOOL_SPECIFIER_TYPES)
    .map(([tool, kind]) => `${tool}(${kind})`)
    .join('、');
  return `你是一个权限规则翻译器。用户用一句中文描述一条权限规则，你把它翻译成一条结构化草稿。

只返回一个 JSON 对象，不要有任何其他文字。两种返回：

能翻译时：
{"status":"ok","tool":"工具名","pattern":"通配模式（该工具支持模式时才给，可省略）","behavior":"allow 或 ask 或 deny","examples":{"hit":["会被这条规则命中的真实命令或文件路径"],"miss":["不会被命上的真实命令或文件路径"]}}

没法可靠翻译时：
{"status":"unrecognized","reason":"一句话说明为什么"}

规则：
- 工具名必须从这份清单里逐字选（区分大小写）：${toolCatalog.join('、')}
- 只有这些工具能带 pattern：${specifierTools}。Bash 的 pattern 匹配整条终端命令（如 "rm *"、"git push *"）；其余的匹配文件路径（如 "*.env"、"src/**"）。其他工具一律不带 pattern，只用工具名。
- behavior：allow=直接执行不再问；ask=先问用户；deny=一律禁止。
- examples 的 hit 和 miss 各至少 2 条，必须能被通配模式机械验证：hit 条条命中，miss 条条不命中。命令例子给完整命令（如 "rm -rf ./build"），路径例子给完整路径。
- 遇到这些情况返回 unrecognized：主观判断（如「涉及客户隐私」「注意分寸」）、模糊量词（如「合理的」「少量的」）、指不到具体命令/文件路径/工具的要求。
- 用户要求放行高危操作（sudo、rm -rf /、强制推送、SSH 密钥、系统文件）时照常返回 allow 草稿，系统会另行把关。
- 只返回 JSON。`;
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new PermissionTranslateParseError();
  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PermissionTranslateParseError();
    return parsed as Record<string, unknown>;
  } catch {
    throw new PermissionTranslateParseError();
  }
}

/** 识别不了：固定话术给用户；可区分原因只进日志（错题本：降级要留痕）。 */
function unrecognizedResult(sentence: string, cause: string): PermissionTranslateResult {
  logger.warn('NL rule translation unrecognized', { sentence, cause });
  return { status: 'unrecognized', reasonText: NL_RULE_TEXT.unrecognizedReason };
}

/**
 * 一句话 → 确定性规则草稿 + 复述。模型通道故障会抛错（由 ipc 层转成
 * MODEL_UNAVAILABLE 错误响应）；识别不了/受保护是正常返回，不是错误。
 */
export async function translatePermissionSentence(
  sentence: string,
  options: TranslatePermissionOptions = {},
): Promise<PermissionTranslateResult> {
  const trimmed = sentence.trim();
  const catalog = options.toolCatalog ?? [];
  const chat = options.chat ?? defaultChat;

  const raw = await chat([
    { role: 'system', content: buildSystemPrompt(catalog) },
    { role: 'user', content: trimmed },
  ]);
  const parsed = extractJsonObject(raw);

  if (parsed.status === 'unrecognized') {
    return unrecognizedResult(trimmed, `model self-reported: ${String(parsed.reason ?? '(no reason)')}`);
  }

  const draftCandidate: PermissionRuleDraft = {
    tool: typeof parsed.tool === 'string' ? parsed.tool : '',
    ...(typeof parsed.pattern === 'string' ? { pattern: parsed.pattern } : {}),
    behavior: 'ask',
    examples: {
      hit: Array.isArray((parsed.examples as { hit?: unknown } | undefined)?.hit)
        ? ((parsed.examples as { hit: unknown[] }).hit.filter((item): item is string => typeof item === 'string'))
        : [],
      miss: Array.isArray((parsed.examples as { miss?: unknown } | undefined)?.miss)
        ? ((parsed.examples as { miss: unknown[] }).miss.filter((item): item is string => typeof item === 'string'))
        : [],
    },
  };
  if (parsed.behavior === 'allow' || parsed.behavior === 'ask' || parsed.behavior === 'deny') {
    draftCandidate.behavior = parsed.behavior;
  }

  const verdict = validateDraft(draftCandidate, catalog);
  if (!verdict.ok) {
    if (verdict.reason === 'allow_all_bash') {
      // 放行全部 Bash 与探针命中同属「拒绝自动放行」，但规则串仍给出：
      // 用户在卡上改成「先问我 / 永不」时用的就是这条规则。
      const rule = buildRuleString(draftCandidate);
      logger.warn('NL rule allow refused: allow-all bash', { sentence, rule });
      return { status: 'protected', draft: draftCandidate, rule, reasonText: NL_RULE_TEXT.protectedReason };
    }
    return unrecognizedResult(trimmed, `draft validation: ${verdict.reason} ${verdict.detail ?? ''}`.trimEnd());
  }

  const rule = verdict.rule;
  const hasSpecifier = !!parseToolSpecifier(rule).specifier;
  if (verdict.draft.behavior === 'allow' && isProtectedAllowRule(rule)) {
    logger.warn('NL rule allow refused: protected probe', { sentence, rule });
    return { status: 'protected', draft: verdict.draft, rule, reasonText: NL_RULE_TEXT.protectedReason };
  }

  const hitExamples = hasSpecifier ? verdict.draft.examples.hit : [];
  const conflict = options.existingRules
    ? resolveRuleConflict(rule, verdict.draft.behavior, hitExamples, options.existingRules)
    : undefined;
  const effectiveBehavior: NlRuleBehavior = conflict?.effectiveBehavior ?? verdict.draft.behavior;

  return {
    status: 'ok',
    draft: verdict.draft,
    rule,
    behavior: effectiveBehavior,
    restatement: describeRule(rule, effectiveBehavior),
    ...(conflict ? { conflict, reasonText: NL_RULE_TEXT.conflictNote(conflict.existingRule, effectiveBehavior) } : {}),
    ...(hasSpecifier ? { examples: { hit: verdict.draft.examples.hit, miss: verdict.draft.examples.miss } } : {}),
  };
}

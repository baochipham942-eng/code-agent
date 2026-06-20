/**
 * 设计质量检测器的对外入口。
 *
 * `detectFrontend` 扫描单个源码文件文本，返回按严格度与忽略列表过滤后
 * 的发现。它是纯函数、同步——可安全地从工具结果路径上的 PostToolUse
 * 钩子调用。
 */

import { DESIGN_RULES, type RuleContext } from './rules';
import {
  DESIGN_STRICTNESS_LEVELS,
  type DesignFinding,
  type DesignRuleMeta,
  type DesignStrictness,
  type DetectOptions,
} from './types';

/** 检测器理解的文件扩展名。其余返回空发现。 */
export const FRONTEND_EXTENSIONS: readonly string[] = [
  'html',
  'htm',
  'xhtml',
  'css',
  'scss',
  'sass',
  'less',
  'jsx',
  'tsx',
  'vue',
  'svelte',
  'astro',
  'svg',
];

const FRONTEND_EXT_SET = new Set(FRONTEND_EXTENSIONS);

/** 路径的小写扩展名（无点），无则为 ''。 */
export function extensionOf(filePath: string | undefined): string {
  if (!filePath) return '';
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 路径看起来是否为值得扫描的前端源码文件。 */
export function isFrontendPath(filePath: string | undefined): boolean {
  return FRONTEND_EXT_SET.has(extensionOf(filePath));
}

function strictnessRank(level: DesignStrictness): number {
  const idx = DESIGN_STRICTNESS_LEVELS.indexOf(level);
  return idx < 0 ? 1 : idx;
}

/** 默认返回发现的硬上限。 */
const DEFAULT_MAX_FINDINGS = 12;

/**
 * 扫描源码文本得到设计质量发现。当文件不是前端（且提供了路径）、无
 * 命中或全部被过滤时返回空数组。绝不抛错。
 */
export function detectFrontend(source: string, options: DetectOptions = {}): DesignFinding[] {
  if (options.filePath !== undefined && !isFrontendPath(options.filePath)) return [];
  if (typeof source !== 'string' || source.length === 0) return [];

  const strictness = options.strictness ?? 'standard';
  const want = strictnessRank(strictness);
  const ignore = new Set(options.ignoreRules ?? []);
  const ext = extensionOf(options.filePath);
  const lines = source.split(/\r\n|\r|\n/);
  const ctx: RuleContext = {
    source,
    lines,
    ext,
    ...(options.designContext ? { designContext: options.designContext } : {}),
  };

  const findings: DesignFinding[] = [];
  for (const rule of DESIGN_RULES) {
    if (ignore.has(rule.id)) continue;
    if (strictnessRank(rule.minStrictness) > want) continue;
    let hits;
    try {
      hits = rule.run(ctx);
    } catch {
      // 单条出错的规则绝不能拖垮整次扫描。
      continue;
    }
    for (const hit of hits) {
      findings.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        message: hit.message ?? rule.message,
        line: hit.line,
        snippet: hit.snippet,
      });
    }
  }

  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const key = `${f.ruleId}:${f.line}:${f.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => a.line - b.line || a.ruleId.localeCompare(b.ruleId));

  const max = options.maxFindings && options.maxFindings > 0 ? options.maxFindings : DEFAULT_MAX_FINDINGS;
  return deduped.slice(0, max);
}

/** 每条规则的静态元数据，例如供设置 UI 使用。 */
export function listDesignRules(): DesignRuleMeta[] {
  return DESIGN_RULES.map((rule) => ({
    id: rule.id,
    category: rule.category,
    severity: rule.severity,
    minStrictness: rule.minStrictness,
    title: rule.title,
  }));
}

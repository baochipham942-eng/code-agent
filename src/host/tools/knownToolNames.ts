// ============================================================================
// 已知工具名全集 —— 专家详情的工具选择器与 agent.md 启动期校验共用一份真源
// ============================================================================
// 刻意取「宽并集」：protocol registry 实注册名 + CORE_TOOLS + 延迟工具元数据名
// + 别名表的键和值。这是**正向存在性**校验的素材（校验声明的名字存在），不是
// 按名字枚举的拒绝清单——宁可放过一个陌生名，也不能把能用的老 frontmatter 误判成错。
// ============================================================================

import { getProtocolToolSchemas } from './protocolToolRegistration';
import { CORE_TOOLS, DEFERRED_TOOLS_META, TOOL_ALIASES } from '../services/toolSearch/deferredTools';

/**
 * 当前进程里「叫得出名字」的全部工具。
 *
 * protocol registry 是懒单例：只有 `protocolRegistry.ts` 被 import 过（host 进程正常路径）
 * 才有内容。空集合意味着注册表还没起来，调用方应据此跳过校验而不是误报——见
 * `hasProtocolToolRegistry()`。
 */
export function getKnownToolNames(): ReadonlySet<string> {
  return new Set<string>([
    ...getProtocolToolSchemas().map((schema) => schema.name),
    ...CORE_TOOLS,
    ...DEFERRED_TOOLS_META.map((meta) => meta.name),
    ...Object.keys(TOOL_ALIASES),
    ...Object.values(TOOL_ALIASES),
  ]);
}

/** 注册表是否已就绪。未就绪时校验会大面积误报，调用方必须显式跳过并说明。 */
export function hasProtocolToolRegistry(): boolean {
  return getProtocolToolSchemas().length > 0;
}

/** 归一化用于「你是不是想写 X」的近似匹配：忽略大小写与下划线/连字符。 */
function loosely(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '');
}

/** 拆 camelCase / 下划线 / 连字符为小写 token，用于「共享词」近似匹配。 */
function tokensOf(name: string): Set<string> {
  return new Set(
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );
}

/** 与 declared 共享 token 最多的已知工具，最多 limit 个（至少共享 1 个 token）。 */
function nearestByTokens(declared: string, known: ReadonlySet<string>, limit: number): string[] {
  const wanted = tokensOf(declared);
  if (wanted.size === 0) return [];
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of known) {
    let score = 0;
    for (const token of tokensOf(name)) if (wanted.has(token)) score += 1;
    if (score > 0) scored.push({ name, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((item) => item.name);
}

/**
 * 挑出声明里注册表查无此名的工具。
 * 返回 `{ name, suggestion?, nearest? }`：suggestion 是大小写/下划线写法不同的同名工具；
 * nearest 仅在没有 suggestion 时给：按共享词（calendar / meeting 等）挑的最多 3 个真实工具名。
 */
export function findUnknownToolNames(
  declared: readonly string[],
  known: ReadonlySet<string>,
): Array<{ name: string; suggestion?: string; nearest?: string[] }> {
  const looseIndex = new Map<string, string>();
  for (const name of known) {
    if (!looseIndex.has(loosely(name))) looseIndex.set(loosely(name), name);
  }
  return declared
    .filter((name) => !known.has(name))
    .map((name) => {
      const suggestion = looseIndex.get(loosely(name));
      if (suggestion) return { name, suggestion };
      const nearest = nearestByTokens(name, known, 3);
      return nearest.length > 0 ? { name, nearest } : { name };
    });
}

/** 给非程序员看的一句话：哪个专家写错了哪些工具名。 */
export function describeUnknownTools(
  agentName: string,
  unknown: ReadonlyArray<{ name: string; suggestion?: string }>,
): string {
  const items = unknown
    .map((item) => (item.suggestion ? `${item.name}（是不是想写 ${item.suggestion}？）` : item.name))
    .join('、');
  return `专家「${agentName}」声明了不存在的工具：${items}。这些工具不会生效，请在专家详情页的「技能」页核对工具名。`;
}

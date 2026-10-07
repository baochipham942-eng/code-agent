// ============================================================================
// Policy hash — sha256 of the permission policy in effect for one decision.
// Read-only projection. Any failure returns undefined and never throws.
// ============================================================================

import { createHash } from 'node:crypto';
import { resolveEffectivePolicy } from './runPolicySnapshot';
import type { PrefixRule } from '../security/execPolicy';

interface ProjectedRule {
  id: string;
  action: string;
  priority: number;
  matcher: unknown;
}

/** RegExp becomes { source, flags }; functions are omitted; object keys are sorted. */
function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'function') return undefined;
  if (value instanceof RegExp) return { source: value.source, flags: value.flags };
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, seen)).filter((item) => item !== undefined);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const next = sanitize((value as Record<string, unknown>)[key], seen);
      if (next !== undefined) out[key] = next;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function projectRule(rule: { id: string; action: string; priority: number; matcher: unknown }): ProjectedRule {
  return {
    id: rule.id,
    action: rule.action,
    priority: rule.priority,
    matcher: sanitize(rule.matcher, new WeakSet()),
  };
}

function compareProjected(a: ProjectedRule, b: ProjectedRule): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * N-PERM-POLICYVERSION ⑤：哈希覆盖 run 的**有效视图**（rules + exec 规则 + mode）——
 * 账本记下的是实际参与判决的策略状态，而不是被冻结挡掉的活状态。没有快照的路径
 * （CLI/eval/未 begin 的测试）视图 === 活状态，与 ① 的语义无缝衔接。
 */
export function computePolicyHash(sessionId?: string, runId?: string): string | undefined {
  try {
    const view = resolveEffectivePolicy(runId, sessionId);
    const rules = view.rules.map(projectRule).sort(compareProjected);
    const execRules = view.execRules
      .map(projectExecRule)
      .sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
    return createHash('sha256').update(JSON.stringify({ mode: view.mode, rules, execRules })).digest('hex');
  } catch {
    return undefined;
  }
}

function projectExecRule(rule: PrefixRule): { pattern: string; decision: string; source: string } {
  return { pattern: rule.pattern.join(' '), decision: rule.decision, source: rule.source };
}

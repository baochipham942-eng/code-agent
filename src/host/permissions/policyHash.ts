// ============================================================================
// Policy hash — sha256 of the permission policy in effect for one decision.
// Read-only projection. Any failure returns undefined and never throws.
// ============================================================================

import { createHash } from 'node:crypto';
import { getPermissionModeManager } from './modes';
import { getPolicyEngine } from './policyEngine';

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

export function computePolicyHash(sessionId?: string): string | undefined {
  try {
    const mode = getPermissionModeManager().getModeForSession(sessionId);
    const rules = getPolicyEngine().getRules().map(projectRule).sort(compareProjected);
    return createHash('sha256').update(JSON.stringify({ mode, rules })).digest('hex');
  } catch {
    return undefined;
  }
}

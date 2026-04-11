// ============================================================================
// Guard Fabric - Multi-Source Permission Coordinator
// ============================================================================
//
// Sits above the existing policyEngine and coordinates multiple permission
// sources with topology-aware verdict resolution.
// ============================================================================

import { getPolicyEngine } from './policyEngine';
import type { DecisionStep } from '../../shared/types/decisionTrace';
import { createTraceStep } from '../security/decisionTraceBuilder';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type GuardVerdict = 'allow' | 'deny' | 'ask';
export type ExecutionTopology = 'main' | 'async_agent' | 'teammate' | 'coordinator';

export interface GuardSource {
  name: string;
  evaluate(request: GuardRequest): GuardSourceResult | null;
}

export interface GuardRequest {
  tool: string;
  args: Record<string, unknown>;
  topology: ExecutionTopology;
  sessionId?: string;
  agentId?: string;
}

export interface GuardSourceResult {
  verdict: GuardVerdict;
  confidence: number; // 0-1
  source: string;
  reason: string;
}

export interface GuardDecision {
  verdict: GuardVerdict;
  source: string;
  reason: string;
  allResults: GuardSourceResult[];
  /** Trace step for decision transparency (only populated on deny/ask) */
  traceStep?: DecisionStep;
}

// ----------------------------------------------------------------------------
// Topology Rules
// ----------------------------------------------------------------------------

const TOPOLOGY_RULES: Record<string, Partial<Record<ExecutionTopology, GuardVerdict>>> = {
  bash: { async_agent: 'deny', coordinator: 'deny' },
  write: { coordinator: 'deny' },
  edit: { coordinator: 'deny' },
  spawn_agent: { async_agent: 'deny', teammate: 'deny' },
};

// ----------------------------------------------------------------------------
// GuardFabric
// ----------------------------------------------------------------------------

export class GuardFabric {
  private sources: GuardSource[] = [];

  registerSource(source: GuardSource): void {
    this.sources.push(source);
  }

  removeSource(name: string): void {
    this.sources = this.sources.filter((s) => s.name !== name);
  }

  evaluate(request: GuardRequest): GuardDecision {
    const startTime = Date.now();

    // 1. Collect results from all sources
    const results: GuardSourceResult[] = [];
    for (const source of this.sources) {
      const result = source.evaluate(request);
      if (result) results.push(result);
    }

    // 2. Apply topology overrides (highest priority)
    const topologyOverride = this.getTopologyOverride(request.tool, request.topology);
    if (topologyOverride) {
      return {
        verdict: topologyOverride.verdict,
        source: 'topology',
        reason: topologyOverride.reason,
        allResults: results,
        traceStep: topologyOverride.verdict !== 'allow'
          ? createTraceStep('guard_fabric', `topology: ${request.tool}/${request.topology}`, topologyOverride.verdict, topologyOverride.reason, startTime)
          : undefined,
      };
    }

    // 3. Competition: deny > ask > allow; first wins within same level
    if (results.length === 0) {
      return {
        verdict: 'ask',
        source: 'default',
        reason: 'no sources provided a verdict',
        allResults: [],
        traceStep: createTraceStep('guard_fabric', 'no_sources', 'ask', 'no sources provided a verdict', startTime),
      };
    }

    const denies = results.filter((r) => r.verdict === 'deny');
    if (denies.length > 0) {
      return {
        verdict: 'deny',
        source: denies[0].source,
        reason: denies[0].reason,
        allResults: results,
        traceStep: createTraceStep('guard_fabric', `source: ${denies[0].source}`, 'deny', denies[0].reason, startTime),
      };
    }

    const asks = results.filter((r) => r.verdict === 'ask');
    if (asks.length > 0) {
      return {
        verdict: 'ask',
        source: asks[0].source,
        reason: asks[0].reason,
        allResults: results,
        traceStep: createTraceStep('guard_fabric', `source: ${asks[0].source}`, 'ask', asks[0].reason, startTime),
      };
    }

    // allow — no traceStep (zero overhead on hot path)
    const allows = results.filter((r) => r.verdict === 'allow');
    return {
      verdict: 'allow',
      source: allows[0]?.source || 'default',
      reason: allows[0]?.reason || 'allowed',
      allResults: results,
    };
  }

  private getTopologyOverride(
    tool: string,
    topology: ExecutionTopology,
  ): { verdict: GuardVerdict; reason: string } | null {
    const toolRules = TOPOLOGY_RULES[tool];
    if (!toolRules) return null;

    const verdict = toolRules[topology];
    if (!verdict) return null;

    return { verdict, reason: `topology rule: ${tool} not allowed in ${topology} context` };
  }

  /**
   * Fail semantics based on topology.
   * Interactive (main/teammate/coordinator) → fail-open to 'ask'
   * Headless (async_agent) → fail-closed to 'deny'
   */
  getFailBehavior(topology: ExecutionTopology): GuardVerdict {
    return topology === 'async_agent' ? 'deny' : 'ask';
  }
}

// ----------------------------------------------------------------------------
// PolicyEngineSource
// ----------------------------------------------------------------------------

export class PolicyEngineSource implements GuardSource {
  name = 'rules';

  evaluate(request: GuardRequest): GuardSourceResult | null {
    try {
      const result = getPolicyEngine().evaluate({
        tool: request.tool,
        level: 'execute',
        description: `tool: ${request.tool}`,
        command: request.args?.command as string,
        filePath: (request.args?.filePath as string) || (request.args?.file_path as string),
        sessionId: request.sessionId,
      });

      // policyEngine uses 'prompt'; map to 'ask'
      const verdict: GuardVerdict =
        result.action === 'allow' ? 'allow' : result.action === 'deny' ? 'deny' : 'ask';

      return { verdict, confidence: 1.0, source: 'rules', reason: result.reason || 'policy engine' };
    } catch {
      return null; // source unavailable
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: GuardFabric | null = null;

export function getGuardFabric(): GuardFabric {
  if (!instance) instance = new GuardFabric();
  return instance;
}

export function resetGuardFabric(): void {
  instance = null;
}

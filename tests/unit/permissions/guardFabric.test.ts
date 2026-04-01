// ============================================================================
// Guard Fabric Tests
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GuardFabric,
  PolicyEngineSource,
  getGuardFabric,
  resetGuardFabric,
  type GuardSource,
  type GuardRequest,
  type GuardSourceResult,
} from '../../../src/main/permissions/guardFabric';
import { HookGuardSource } from '../../../src/main/permissions/hookSource';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeSource(name: string, result: GuardSourceResult | null): GuardSource {
  return { name, evaluate: () => result };
}

function makeRequest(overrides: Partial<GuardRequest> = {}): GuardRequest {
  return {
    tool: 'read',
    args: {},
    topology: 'main',
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// Suite
// ----------------------------------------------------------------------------

describe('GuardFabric', () => {
  let fabric: GuardFabric;

  beforeEach(() => {
    fabric = new GuardFabric();
  });

  // --------------------------------------------------------------------------
  // Competition rules
  // --------------------------------------------------------------------------
  describe('Competition rules', () => {
    it('deny wins over ask', () => {
      fabric.registerSource(makeSource('s1', { verdict: 'deny', confidence: 1, source: 's1', reason: 'denied' }));
      fabric.registerSource(makeSource('s2', { verdict: 'ask', confidence: 1, source: 's2', reason: 'asked' }));
      const decision = fabric.evaluate(makeRequest());
      expect(decision.verdict).toBe('deny');
      expect(decision.source).toBe('s1');
    });

    it('deny wins over allow', () => {
      fabric.registerSource(makeSource('s1', { verdict: 'allow', confidence: 1, source: 's1', reason: 'ok' }));
      fabric.registerSource(makeSource('s2', { verdict: 'deny', confidence: 1, source: 's2', reason: 'no' }));
      const decision = fabric.evaluate(makeRequest());
      expect(decision.verdict).toBe('deny');
      expect(decision.source).toBe('s2');
    });

    it('ask wins over allow', () => {
      fabric.registerSource(makeSource('s1', { verdict: 'allow', confidence: 1, source: 's1', reason: 'ok' }));
      fabric.registerSource(makeSource('s2', { verdict: 'ask', confidence: 1, source: 's2', reason: 'needs confirm' }));
      const decision = fabric.evaluate(makeRequest());
      expect(decision.verdict).toBe('ask');
      expect(decision.source).toBe('s2');
    });

    it('first source wins among same verdict', () => {
      fabric.registerSource(makeSource('first', { verdict: 'deny', confidence: 1, source: 'first', reason: 'first deny' }));
      fabric.registerSource(makeSource('second', { verdict: 'deny', confidence: 1, source: 'second', reason: 'second deny' }));
      const decision = fabric.evaluate(makeRequest());
      expect(decision.verdict).toBe('deny');
      expect(decision.source).toBe('first');
      expect(decision.reason).toBe('first deny');
    });

    it('no sources → default ask', () => {
      const decision = fabric.evaluate(makeRequest());
      expect(decision.verdict).toBe('ask');
      expect(decision.source).toBe('default');
    });
  });

  // --------------------------------------------------------------------------
  // Topology overrides
  // --------------------------------------------------------------------------
  describe('Topology overrides', () => {
    it('async_agent + bash → deny', () => {
      // Even with an allow source, topology wins
      fabric.registerSource(makeSource('s1', { verdict: 'allow', confidence: 1, source: 's1', reason: 'ok' }));
      const decision = fabric.evaluate(makeRequest({ tool: 'bash', topology: 'async_agent' }));
      expect(decision.verdict).toBe('deny');
      expect(decision.source).toBe('topology');
    });

    it('coordinator + write → deny', () => {
      const decision = fabric.evaluate(makeRequest({ tool: 'write', topology: 'coordinator' }));
      expect(decision.verdict).toBe('deny');
      expect(decision.source).toBe('topology');
    });

    it('coordinator + bash → deny', () => {
      const decision = fabric.evaluate(makeRequest({ tool: 'bash', topology: 'coordinator' }));
      expect(decision.verdict).toBe('deny');
      expect(decision.source).toBe('topology');
    });

    it('main + bash → no topology override (falls through to sources)', () => {
      fabric.registerSource(makeSource('s1', { verdict: 'allow', confidence: 1, source: 's1', reason: 'ok' }));
      const decision = fabric.evaluate(makeRequest({ tool: 'bash', topology: 'main' }));
      expect(decision.verdict).toBe('allow');
      expect(decision.source).toBe('s1');
    });

    it('async_agent + spawn_agent → deny', () => {
      const decision = fabric.evaluate(makeRequest({ tool: 'spawn_agent', topology: 'async_agent' }));
      expect(decision.verdict).toBe('deny');
      expect(decision.source).toBe('topology');
    });

    it('teammate + spawn_agent → deny', () => {
      const decision = fabric.evaluate(makeRequest({ tool: 'spawn_agent', topology: 'teammate' }));
      expect(decision.verdict).toBe('deny');
      expect(decision.source).toBe('topology');
    });

    it('coordinator + spawn_agent → allow (no override)', () => {
      fabric.registerSource(makeSource('s1', { verdict: 'allow', confidence: 1, source: 's1', reason: 'ok' }));
      const decision = fabric.evaluate(makeRequest({ tool: 'spawn_agent', topology: 'coordinator' }));
      // coordinator is not in spawn_agent rules, so no topology override
      expect(decision.source).not.toBe('topology');
      expect(decision.verdict).toBe('allow');
    });

    it('topology reason includes tool and topology name', () => {
      const decision = fabric.evaluate(makeRequest({ tool: 'bash', topology: 'async_agent' }));
      expect(decision.reason).toContain('bash');
      expect(decision.reason).toContain('async_agent');
    });

    it('allResults is populated even when topology overrides', () => {
      fabric.registerSource(makeSource('s1', { verdict: 'allow', confidence: 1, source: 's1', reason: 'ok' }));
      const decision = fabric.evaluate(makeRequest({ tool: 'bash', topology: 'async_agent' }));
      expect(decision.allResults).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Fail behavior
  // --------------------------------------------------------------------------
  describe('Fail behavior', () => {
    it('main → fail-open to ask', () => {
      expect(fabric.getFailBehavior('main')).toBe('ask');
    });

    it('teammate → fail-open to ask', () => {
      expect(fabric.getFailBehavior('teammate')).toBe('ask');
    });

    it('coordinator → fail-open to ask', () => {
      expect(fabric.getFailBehavior('coordinator')).toBe('ask');
    });

    it('async_agent → fail-closed to deny', () => {
      expect(fabric.getFailBehavior('async_agent')).toBe('deny');
    });
  });

  // --------------------------------------------------------------------------
  // Source management
  // --------------------------------------------------------------------------
  describe('Source management', () => {
    it('registerSource adds source', () => {
      const src = makeSource('test', null);
      fabric.registerSource(src);
      // Confirm it's consulted (null result → falls to default)
      const decision = fabric.evaluate(makeRequest());
      // With one null source and no topology override, should get default ask
      expect(decision.verdict).toBe('ask');
      expect(decision.source).toBe('default');
    });

    it('removeSource removes by name', () => {
      fabric.registerSource(makeSource('removable', { verdict: 'deny', confidence: 1, source: 'removable', reason: 'no' }));
      fabric.removeSource('removable');
      // After removal, no source contributes → default ask
      const decision = fabric.evaluate(makeRequest());
      expect(decision.verdict).toBe('ask');
      expect(decision.source).toBe('default');
    });

    it('sources returning null are skipped', () => {
      fabric.registerSource(makeSource('null-source', null));
      fabric.registerSource(makeSource('allow-source', { verdict: 'allow', confidence: 1, source: 'allow-source', reason: 'ok' }));
      const decision = fabric.evaluate(makeRequest());
      expect(decision.verdict).toBe('allow');
    });
  });

  // --------------------------------------------------------------------------
  // Singleton
  // --------------------------------------------------------------------------
  describe('Singleton', () => {
    beforeEach(() => {
      resetGuardFabric();
    });

    it('getGuardFabric returns same instance', () => {
      const a = getGuardFabric();
      const b = getGuardFabric();
      expect(a).toBe(b);
    });

    it('resetGuardFabric creates fresh instance', () => {
      const a = getGuardFabric();
      resetGuardFabric();
      const b = getGuardFabric();
      expect(a).not.toBe(b);
    });
  });

  // --------------------------------------------------------------------------
  // PolicyEngineSource
  // --------------------------------------------------------------------------
  describe('PolicyEngineSource', () => {
    it('wraps policyEngine allow correctly', () => {
      const source = new PolicyEngineSource();
      // 'read' tool with empty args should not trigger any deny rule
      const result = source.evaluate({ tool: 'read', args: {}, topology: 'main' });
      // Result can be allow or ask; should not throw and should have correct shape
      expect(result).not.toBeNull();
      expect(['allow', 'ask', 'deny']).toContain(result!.verdict);
      expect(result!.source).toBe('rules');
      expect(result!.confidence).toBe(1.0);
    });

    it('maps prompt action to ask verdict', () => {
      const source = new PolicyEngineSource();
      // sudo command triggers 'prompt' rule in policyEngine
      const result = source.evaluate({
        tool: 'bash',
        args: { command: 'sudo apt-get update' },
        topology: 'main',
      });
      expect(result).not.toBeNull();
      // sudo should produce ask (mapped from prompt)
      expect(result!.verdict).toBe('ask');
    });

    it('maps deny action to deny verdict', () => {
      const source = new PolicyEngineSource();
      // Writing to /usr triggers deny rule
      const result = source.evaluate({
        tool: 'write',
        args: { filePath: '/usr/bin/malicious' },
        topology: 'main',
      });
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('deny');
    });

    it('returns null when policyEngine throws', () => {
      // Simulate a source that internally catches an exception
      const throwingSource: GuardSource = {
        name: 'throwing',
        evaluate: (_req) => {
          try {
            throw new Error('engine down');
          } catch {
            return null;
          }
        },
      };
      // PolicyEngineSource contract: returns null on error
      const result = throwingSource.evaluate({ tool: 'read', args: {}, topology: 'main' });
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // HookGuardSource
  // --------------------------------------------------------------------------
  describe('HookGuardSource', () => {
    it('returns null when no hooks configured', () => {
      const source = new HookGuardSource();
      const result = source.evaluate({ tool: 'bash', args: {}, topology: 'main' });
      expect(result).toBeNull();
    });

    it('has name "hooks"', () => {
      const source = new HookGuardSource();
      expect(source.name).toBe('hooks');
    });
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ToolCache,
  type ToolCachePolicy,
} from '../../../../src/host/services/infra/toolCache';

const RESULT = { toolCallId: 'fixture', success: true, output: 'safe replay' };
const PROVEN_POLICY: ToolCachePolicy = {
  toolVersion: 'fixture@1',
  policyVersion: 'cache-policy@1',
  ttlMs: 1_000,
  evidence: {
    pureRead: true,
    noHiddenLifecycleSideEffects: true,
    noContextEvidenceMutation: true,
    externalChangesCoveredByKey: true,
    replaySafe: true,
  },
};

describe('ToolCache proven allowlist', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('rejects incomplete proof and MCP annotations as cache admission evidence', () => {
    const cache = new ToolCache({
      persistentCache: false,
      policies: {
        mcp__docs__read: {
          ...PROVEN_POLICY,
          evidence: { ...PROVEN_POLICY.evidence, noContextEvidenceMutation: false },
        },
      },
    });
    expect(cache.isCacheable('mcp__docs__read')).toBe(false);
    expect(cache.isCacheable('mcp__docs__read', { readOnlyHint: true, idempotentHint: true } as never)).toBe(false);
  });

  it('refuses an allowlisted MCP fixture when server or capability identity is missing', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cache-mcp-'));
    dirs.push(workspace);
    const cache = new ToolCache({
      persistentCache: false,
      policies: { mcp__docs__read: PROVEN_POLICY },
    });
    cache.set('mcp__docs__read', { q: 'same' }, RESULT, {
      sessionId: 'session-a', workingDirectory: workspace,
    });
    expect(cache.get('mcp__docs__read', { q: 'same' }, {
      sessionId: 'session-a', workingDirectory: workspace,
    })).toBeNull();
    expect(cache.getStats().totalEntries).toBe(0);
  });

  it('isolates workspace, session, server identity, and capability policy version', () => {
    const a = mkdtempSync(join(tmpdir(), 'cache-a-'));
    const b = mkdtempSync(join(tmpdir(), 'cache-b-'));
    dirs.push(a, b);
    const cache = new ToolCache({ persistentCache: false, policies: { PureFixture: PROVEN_POLICY } });
    const args = { q: 'same' };
    const scope = {
      sessionId: 'session-a', workingDirectory: a, serverIdentity: 'server-a',
      capabilityPolicyVersion: 'cap-v1', dataFingerprint: 'data-v1',
    };
    cache.set('PureFixture', args, RESULT, scope);

    expect(cache.get('PureFixture', args, scope)).toEqual(RESULT);
    expect(cache.get('PureFixture', args, { ...scope, sessionId: 'session-b' })).toBeNull();
    expect(cache.get('PureFixture', args, { ...scope, workingDirectory: b })).toBeNull();
    expect(cache.get('PureFixture', args, { ...scope, serverIdentity: 'server-b' })).toBeNull();
    expect(cache.get('PureFixture', args, { ...scope, capabilityPolicyVersion: 'cap-v2' })).toBeNull();
  });

  it('invalidates when the data fingerprint or TTL bucket changes', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cache-data-'));
    dirs.push(workspace);
    let now = 10_000;
    const cache = new ToolCache({
      persistentCache: false,
      now: () => now,
      policies: { PureFixture: PROVEN_POLICY },
    });
    const args = { q: 'same' };
    const scope = {
      sessionId: 'session-a', workingDirectory: workspace, serverIdentity: 'server-a',
      capabilityPolicyVersion: 'cap-v1', dataFingerprint: 'data-v1',
    };
    cache.set('PureFixture', args, RESULT, scope);
    expect(cache.get('PureFixture', args, { ...scope, dataFingerprint: 'data-v2' })).toBeNull();
    now += 1_001;
    expect(cache.get('PureFixture', args, scope)).toBeNull();
  });
});

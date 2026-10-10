import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../../../src/host/tools/registry';
import { registerMigratedTools } from '../../../../../src/host/tools/modules';
import { CORE_TOOLS, DEFERRED_TOOLS_META } from '../../../../../src/host/services/toolSearch/deferredTools';
import { isCrossSessionDelegationEnabled } from '../../../../../src/host/services/delegation/crossSessionDelegationFlag';

afterEach(() => {
  delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
});

describe('crossSessionDelegation visibility', () => {
  it('defaults off and keeps both names out of core/deferred metadata', () => {
    expect(isCrossSessionDelegationEnabled()).toBe(false);
    const registry = new ToolRegistry();
    registerMigratedTools(registry, 'linux', false);
    expect(registry.has('delegate_session')).toBe(false);
    expect(registry.has('list_session_candidates')).toBe(false);
    expect(CORE_TOOLS).not.toContain('delegate_session');
    expect(DEFERRED_TOOLS_META.map((meta) => meta.name)).not.toContain('list_session_candidates');
  });

  it('flag on registers both tools, while the forced-off handler still rejects', async () => {
    const registry = new ToolRegistry();
    registerMigratedTools(registry, 'linux', true);
    expect(registry.has('delegate_session')).toBe(true);
    expect(registry.has('list_session_candidates')).toBe(true);
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '0';
    const handler = await registry.resolve('delegate_session');
    const result = await handler.execute({ action: 'create_new', text: 'x' }, {
      sessionId: 'origin', workingDir: '/tmp', abortSignal: new AbortController().signal,
      logger: { debug() {}, info() {}, warn() {}, error() {} }, emit() {},
    }, async () => ({ allow: true }));
    expect(result).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' });
  });
});


import { describe, expect, it } from 'vitest';
import {
  NETWORK_COMMANDS,
  resolveSandboxNetworkPolicy,
} from '../../../../src/host/sandbox/networkPolicy';

describe('resolveSandboxNetworkPolicy', () => {
  it('keeps non-network commands offline', () => {
    expect(resolveSandboxNetworkPolicy({ command: 'echo hello' })).toBe(false);
  });

  it('allows npm install to use network', () => {
    expect(resolveSandboxNetworkPolicy({ command: 'npm install left-pad' })).toBe(true);
  });

  it('allows curl to use network', () => {
    expect(resolveSandboxNetworkPolicy({ command: 'curl https://example.com' })).toBe(true);
  });

  it('allows compound commands when any segment invokes a network tool', () => {
    expect(resolveSandboxNetworkPolicy({ command: 'node x.js && curl https://example.com' })).toBe(true);
  });

  it('forces redline commands offline even when they invoke network tools', () => {
    expect(resolveSandboxNetworkPolicy({ command: 'curl https://example.com', redline: true })).toBe(false);
  });

  it('exports the command list tested by the policy', () => {
    expect(NETWORK_COMMANDS).toContain('curl');
    expect(NETWORK_COMMANDS).toContain('npm');
    expect(NETWORK_COMMANDS).toContain('gh');
  });
});

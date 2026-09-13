import { afterEach, describe, expect, it } from 'vitest';
import { OS_SANDBOX_CODES } from '../../../../src/shared/constants/sandbox';
import {
  classifyUnsandboxableCommand,
  resolveOsSandboxDecision,
  UNSANDBOXABLE_EXCEPTIONS,
} from '../../../../src/host/sandbox/osSandboxPolicy';

const base = {
  sandboxAvailable: true,
  sandboxEnabled: true,
  unattended: false,
  writeFence: false,
  evalRealRoot: false,
  multiRoot: false,
  platform: 'darwin' as NodeJS.Platform,
};

describe('osSandboxPolicy', () => {
  afterEach(() => {
    delete process.env.OS_SANDBOX_ENABLED;
  });

  it('default / acceptEdits 在可用时默认 apply', () => {
    for (const permissionMode of ['default', 'acceptEdits'] as const) {
      const decision = resolveOsSandboxDecision({
        ...base,
        command: 'echo hello',
        permissionMode,
      });
      expect(decision).toMatchObject({
        apply: true,
        sandboxed: true,
        degraded: false,
        code: OS_SANDBOX_CODES.APPLIED,
      });
    }
  });

  it('bypassPermissions 仍强制 apply', () => {
    expect(resolveOsSandboxDecision({
      ...base,
      command: 'echo hello',
      permissionMode: 'bypassPermissions',
    }).apply).toBe(true);
  });

  it('readOnly 不在灰度名单内', () => {
    expect(resolveOsSandboxDecision({
      ...base,
      command: 'echo hello',
      permissionMode: 'readOnly',
    }).code).toBe(OS_SANDBOX_CODES.MODE_NOT_IN_ROLLOUT);
  });

  it('关 env 后 default 档不 apply，并显式 degraded', () => {
    const decision = resolveOsSandboxDecision({
      ...base,
      command: 'echo hello',
      permissionMode: 'default',
      sandboxEnabled: false,
    });
    expect(decision.apply).toBe(false);
    expect(decision.degraded).toBe(true);
    expect(decision.code).toBe(OS_SANDBOX_CODES.DEGRADED_DISABLED);
  });

  it('write-fence 在关 env 时仍 apply', () => {
    expect(resolveOsSandboxDecision({
      ...base,
      command: 'printf x > notes.txt',
      permissionMode: 'default',
      sandboxEnabled: false,
      writeFence: true,
    }).apply).toBe(true);
  });

  it('平台沙箱不可用时 default 档显式降级而不是硬套 wrap', () => {
    const decision = resolveOsSandboxDecision({
      ...base,
      command: 'echo hello',
      permissionMode: 'default',
      sandboxAvailable: false,
    });
    expect(decision.apply).toBe(false);
    expect(decision.degraded).toBe(true);
    expect(decision.code).toBe(OS_SANDBOX_CODES.DEGRADED_UNAVAILABLE);
  });

  it('平台沙箱不可用时 bypass 仍要求 wrap（由调用方硬报错）', () => {
    const decision = resolveOsSandboxDecision({
      ...base,
      command: 'echo hello',
      permissionMode: 'bypassPermissions',
      sandboxAvailable: false,
    });
    expect(decision.apply).toBe(true);
    expect(decision.degradeIfUnavailable).toBe(false);
  });

  it('平台沙箱不可用时多根显式降级而不是硬报错（旧默认本就裸跑）', () => {
    const decision = resolveOsSandboxDecision({
      ...base,
      command: 'echo hello',
      permissionMode: 'default',
      multiRoot: true,
      sandboxAvailable: false,
    });
    expect(decision.apply).toBe(false);
    expect(decision.degraded).toBe(true);
    expect(decision.code).toBe(OS_SANDBOX_CODES.DEGRADED_UNAVAILABLE);
    expect(decision.degradeIfUnavailable).toBe(true);
  });

  it('docker / open 在 default 档进入白名单例外', () => {
    expect(classifyUnsandboxableCommand('docker build .', 'darwin')?.id).toBe('docker_engine');
    expect(classifyUnsandboxableCommand('sudo podman ps', 'linux')?.id).toBe('docker_engine');
    expect(classifyUnsandboxableCommand('open Preview.app', 'darwin')?.id).toBe('macos_launch_services');
    expect(classifyUnsandboxableCommand('open Preview.app', 'linux')).toBeUndefined();
    expect(resolveOsSandboxDecision({
      ...base,
      command: 'docker build .',
      permissionMode: 'default',
    })).toMatchObject({
      apply: false,
      degraded: true,
      exception: 'docker_engine',
      code: OS_SANDBOX_CODES.DEGRADED_UNSANDBOXABLE,
    });
  });

  it('bypass 不走白名单例外', () => {
    expect(resolveOsSandboxDecision({
      ...base,
      command: 'docker build .',
      permissionMode: 'bypassPermissions',
    }).apply).toBe(true);
  });

  it('每条白名单例外都有理由', () => {
    expect(UNSANDBOXABLE_EXCEPTIONS.length).toBeLessThanOrEqual(10);
    for (const entry of UNSANDBOXABLE_EXCEPTIONS) {
      expect(entry.reason.trim().length).toBeGreaterThan(20);
    }
  });
});

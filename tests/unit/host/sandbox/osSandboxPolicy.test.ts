import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OS_SANDBOX_CODES } from '../../../../src/shared/constants/sandbox';
import { resolveOsSandboxDecision } from '../../../../src/host/sandbox/osSandboxPolicy';

const POLICY_SOURCE = path.resolve(__dirname, '../../../../src/host/sandbox/osSandboxPolicy.ts');

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
    const degradeOf = (command: string, platform: NodeJS.Platform) =>
      resolveOsSandboxDecision({ ...base, command, permissionMode: 'default', platform });
    expect(degradeOf('docker build .', 'darwin')).toMatchObject({
      apply: false, degraded: true, exception: 'docker_engine',
      code: OS_SANDBOX_CODES.DEGRADED_UNSANDBOXABLE,
    });
    expect(degradeOf('sudo podman ps', 'linux').exception).toBe('docker_engine');
    expect(degradeOf('open Preview.app', 'darwin').exception).toBe('macos_launch_services');
    expect(degradeOf('open Preview.app', 'linux').apply).toBe(true);
  });

  it('白名单例外只认命令位：参数里的 docker/open 不降级（PR #1789 复审 Important）', () => {
    for (const command of ['echo docker build .', 'cat open', 'echo "osascript -e hi"', 'printf %s podman']) {
      const decision = resolveOsSandboxDecision({ ...base, command, permissionMode: 'default' });
      expect(decision.apply).toBe(true);
      expect(decision.degraded).toBe(false);
    }
    // 命令连接符之后仍认命令位
    expect(resolveOsSandboxDecision({ ...base, command: 'cd x && docker build .', permissionMode: 'default' }).exception)
      .toBe('docker_engine');
  });

  it('bypass 不走白名单例外', () => {
    expect(resolveOsSandboxDecision({
      ...base,
      command: 'docker build .',
      permissionMode: 'bypassPermissions',
    }).apply).toBe(true);
  });

  it('每条白名单例外都有理由', () => {
    const source = readFileSync(POLICY_SOURCE, 'utf8');
    const ids = source.match(/^ {4}id: '/gm) ?? [];
    const reasons = source.match(/^ {4}reason:/gm) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(10);
    expect(reasons.length).toBe(ids.length);
  });
});

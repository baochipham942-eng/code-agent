import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 模拟 child_process.execFile：注册表用 promisify(execFile) 跑 `which <cmd>`（定位二进制）
// 和 `<cmd> --version`（探活）。这里按 binary 名注入「装了 / 没装」两种结果，验证
// detectMimo / detectKimi 产出的 descriptor 字段。
const mocks = vi.hoisted(() => ({
  // 命令名 -> 是否在 PATH 上找到（resolveBinary 的 `which` 结果）
  installed: new Set<string>(),
}));

vi.mock('child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    // resolveBinary: `which <command>` / `where <command>`
    if (file === 'which' || file === 'where') {
      const command = args[0];
      if (mocks.installed.has(command)) {
        callback(null, { stdout: `/usr/local/bin/${command}\n`, stderr: '' });
      } else {
        callback(new Error(`${command} not found`));
      }
      return;
    }
    // probeCommand: `<binaryPath> --version`
    const command = file.split('/').pop() ?? file;
    if (mocks.installed.has(command)) {
      callback(null, { stdout: `${command} 1.2.3\n`, stderr: '' });
    } else {
      callback(new Error(`${command} failed`));
    }
  },
}));

vi.mock('../../../src/host/services/infra/shellEnvironment', () => ({
  getShellPath: () => '/usr/local/bin:/usr/bin:/bin',
}));

import { AgentEngineRegistry } from '../../../src/host/services/agentEngine/agentEngineRegistry';

describe('AgentEngineRegistry mimo/kimi detection', () => {
  beforeEach(() => {
    mocks.installed.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists native + codex + claude + mimo + kimi descriptors', async () => {
    const descriptors = await new AgentEngineRegistry().list();
    expect(descriptors.map((d) => d.kind)).toEqual([
      'native',
      'codex_cli',
      'claude_code',
      'mimo_code',
      'kimi_code',
    ]);
  });

  it('marks MiMo-Code installed when the binary is on PATH and --version succeeds', async () => {
    mocks.installed.add('mimo');
    const descriptor = await new AgentEngineRegistry().get('mimo_code');

    expect(descriptor.kind).toBe('mimo_code');
    expect(descriptor.label).toBe('MiMo-Code');
    expect(descriptor.installState).toBe('installed');
    expect(descriptor.executable).toBe(true);
    expect(descriptor.runtimeState).toBe('ready');
    expect(descriptor.command).toBe('mimo run --format json');
    expect(descriptor.binaryPath).toBe('/usr/local/bin/mimo');
    expect(descriptor.version).toBe('mimo 1.2.3');
    expect(descriptor.defaultPermissionProfile).toBe('read_only');
    expect(descriptor.cwdPolicy).toBe('workspace_only');
    expect(descriptor.riskTier).toBe('medium');
    expect(descriptor.capabilities).toEqual(['execute', 'stream_events', 'review']);
    expect(descriptor.reliability?.cliStatus).toBe('available');
    expect(descriptor.reliability?.streamingMode).toBe('json');
    expect(descriptor.lastError).toBeUndefined();
  });

  it('degrades MiMo-Code to missing/non-executable when the binary is absent', async () => {
    const descriptor = await new AgentEngineRegistry().get('mimo_code');

    expect(descriptor.installState).toBe('missing');
    expect(descriptor.executable).toBe(false);
    expect(descriptor.runtimeState).toBe('not_configured');
    expect(descriptor.capabilities).toEqual([]);
    expect(descriptor.binaryPath).toBeUndefined();
    expect(descriptor.reliability?.cliStatus).toBe('missing');
    expect(descriptor.lastError).toContain('mimo');
  });

  it('marks Kimi Code installed when the binary is on PATH and --version succeeds', async () => {
    mocks.installed.add('kimi');
    const descriptor = await new AgentEngineRegistry().get('kimi_code');

    expect(descriptor.kind).toBe('kimi_code');
    expect(descriptor.label).toBe('Kimi Code');
    expect(descriptor.installState).toBe('installed');
    expect(descriptor.executable).toBe(true);
    expect(descriptor.runtimeState).toBe('ready');
    expect(descriptor.command).toBe('kimi -p --output-format stream-json');
    expect(descriptor.binaryPath).toBe('/usr/local/bin/kimi');
    expect(descriptor.version).toBe('kimi 1.2.3');
    expect(descriptor.defaultPermissionProfile).toBe('read_only');
    expect(descriptor.cwdPolicy).toBe('workspace_only');
    expect(descriptor.riskTier).toBe('medium');
    expect(descriptor.capabilities).toEqual(['execute', 'stream_events', 'review']);
    expect(descriptor.reliability?.cliStatus).toBe('available');
    expect(descriptor.reliability?.streamingMode).toBe('stream_json');
    expect(descriptor.lastError).toBeUndefined();
  });

  it('degrades Kimi Code to missing/non-executable when the binary is absent', async () => {
    const descriptor = await new AgentEngineRegistry().get('kimi_code');

    expect(descriptor.installState).toBe('missing');
    expect(descriptor.executable).toBe(false);
    expect(descriptor.runtimeState).toBe('not_configured');
    expect(descriptor.capabilities).toEqual([]);
    expect(descriptor.binaryPath).toBeUndefined();
    expect(descriptor.reliability?.cliStatus).toBe('missing');
    expect(descriptor.lastError).toContain('kimi');
  });

  it('isolates detection per engine (mimo installed does not flip kimi)', async () => {
    mocks.installed.add('mimo');
    const descriptors = await new AgentEngineRegistry().list();
    const mimo = descriptors.find((d) => d.kind === 'mimo_code');
    const kimi = descriptors.find((d) => d.kind === 'kimi_code');

    expect(mimo?.installState).toBe('installed');
    expect(kimi?.installState).toBe('missing');
  });
});

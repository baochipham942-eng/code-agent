import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 模拟 child_process.execFile：注册表用 promisify(execFile) 跑 `which <cmd>`（定位二进制）
// 和 `<cmd> --version`（探活）。这里按 binary 名注入「装了 / 没装」两种结果，验证
// detectMimo / detectKimi 产出的 descriptor 字段。
const mocks = vi.hoisted(() => ({
  // 命令名 -> 是否在 PATH 上找到（resolveBinary 的 `which` 结果）
  installed: new Set<string>(),
  authenticated: new Set<string>(),
  existingPaths: new Set<string>(),
}));

vi.mock('node:fs/promises', () => ({
  access: async (file: string) => {
    if (!mocks.existingPaths.has(file)) throw new Error(`${file} not found`);
  },
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
      if (args.join(' ') === 'login status') {
        callback(null, {
          stdout: mocks.authenticated.has(command) ? 'Logged in using ChatGPT\n' : 'Not logged in\n',
          stderr: '',
        });
        return;
      }
      if (args.join(' ') === 'auth status') {
        callback(null, {
          stdout: JSON.stringify({ loggedIn: mocks.authenticated.has(command) }),
          stderr: '',
        });
        return;
      }
      if (args.join(' ') === 'status') {
        callback(null, {
          stdout: mocks.authenticated.has(command)
            ? 'Version: 1.0.47\nAccount: authenticated-user\n'
            : 'Version: 1.0.47\nAccount: Not logged in\n',
          stderr: '',
        });
        return;
      }
      if (args.join(' ') === 'provider list --json') {
        callback(null, {
          stdout: mocks.authenticated.has(command)
            ? JSON.stringify({ providers: { 'managed:kimi-code': { type: 'kimi' } }, models: {} })
            : JSON.stringify({ providers: {}, models: {} }),
          stderr: '',
        });
        return;
      }
      if (args.join(' ') === 'models') {
        callback(null, {
          stdout: mocks.authenticated.has(command)
            ? 'You are logged in with grok.com.\\n\\nDefault model: grok-4.5\\n\\nAvailable models:\\n  * grok-4.5 (default)\\n'
            : 'You are not logged in.\\n',
          stderr: '',
        });
        return;
      }
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
    mocks.authenticated.clear();
    mocks.existingPaths.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists all manifest-backed executable descriptors', async () => {
    const descriptors = await new AgentEngineRegistry().list();
    expect(descriptors.map((d) => d.kind)).toEqual([
      'native',
      'codex_cli',
      'claude_code',
      'mimo_code',
      'kimi_code',
      'codebuddy_code',
      'grok_cli',
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

  it('makes an installed Kimi source selectable only when the official CLI confirms login', async () => {
    mocks.installed.add('kimi');
    let source = (await new AgentEngineRegistry().listSources())
      .find((entry) => entry.kind === 'kimi_code');
    expect(source).toMatchObject({
      detected: true,
      selectable: false,
      authState: 'needs_login',
    });

    mocks.authenticated.add('kimi');
    source = (await new AgentEngineRegistry().listSources())
      .find((entry) => entry.kind === 'kimi_code');
    expect(source).toMatchObject({
      detected: true,
      selectable: true,
      authState: 'authenticated',
    });
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

  it('keeps unverified recommendation-only manifests visible but fail-closed', async () => {
    const sources = await new AgentEngineRegistry().listSources();
    const cursor = sources.find((source) => source.manifestId === 'cursor_cli');

    expect(sources).toHaveLength(10);
    expect(cursor).toMatchObject({
      detected: false,
      selectable: false,
      evidence: 'none',
    });
  });

  it('detects the WorkBuddy app-bundled CLI and selects it only with official client state', async () => {
    const binaryPath = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
    const authMarker = `${process.env.HOME}/.workbuddy/user-state.json`;
    mocks.existingPaths.add(binaryPath);
    mocks.installed.add('codebuddy');

    let sources = await new AgentEngineRegistry({ cacheTtlMs: 0 }).listSources();
    expect(sources.find((source) => source.manifestId === 'codebuddy_code')).toMatchObject({
      kind: 'codebuddy_code',
      detected: true,
      selectable: false,
      authState: 'needs_login',
      binaryPath,
      evidence: 'production',
    });

    mocks.existingPaths.add(authMarker);
    sources = await new AgentEngineRegistry({ cacheTtlMs: 0 }).listSources();
    expect(sources.find((source) => source.manifestId === 'codebuddy_code')).toMatchObject({
      kind: 'codebuddy_code',
      detected: true,
      selectable: true,
      authState: 'authenticated',
      binaryPath,
    });
  });

  it('only exposes an official-account source after its non-interactive login probe succeeds', async () => {
    mocks.installed.add('codex');
    let sources = await new AgentEngineRegistry({ cacheTtlMs: 0 }).listSources();
    expect(sources.find((source) => source.manifestId === 'codex_cli')).toMatchObject({
      detected: true,
      selectable: false,
      authState: 'needs_login',
    });

    mocks.authenticated.add('codex');
    sources = await new AgentEngineRegistry({ cacheTtlMs: 0 }).listSources();
    expect(sources.find((source) => source.manifestId === 'codex_cli')).toMatchObject({
      detected: true,
      selectable: true,
      authState: 'authenticated',
    });
  });

  it('detects authenticated Grok Build from its official models command', async () => {
    mocks.installed.add('grok');
    mocks.authenticated.add('grok');
    const source = (await new AgentEngineRegistry({ cacheTtlMs: 0 }).listSources())
      .find((entry) => entry.kind === 'grok_cli');

    expect(source).toMatchObject({
      manifestId: 'grok_cli',
      detected: true,
      selectable: true,
      authState: 'authenticated',
      binaryPath: '/usr/local/bin/grok',
      evidence: 'production',
    });
  });

  it('does not promote a detected spike-only CLI without a production adapter', async () => {
    mocks.installed.add('zulu');
    const sources = await new AgentEngineRegistry().listSources();
    const zulu = sources.find((source) => source.manifestId === 'comate_zulu');

    expect(zulu).toMatchObject({
      detected: true,
      selectable: false,
      evidence: 'local_spike',
      binaryPath: '/usr/local/bin/zulu',
    });
  });

  it('detects Qoder Work but keeps it login-gated and non-selectable', async () => {
    const binaryPath = '/Applications/QwenWorkCN.app/Contents/Resources/bin/qoderclicn';
    mocks.existingPaths.add(binaryPath);
    mocks.installed.add('qoderclicn');

    let sources = await new AgentEngineRegistry({ cacheTtlMs: 0 }).listSources();
    expect(sources.find((source) => source.manifestId === 'qoder_work')).toMatchObject({
      detected: true,
      selectable: false,
      authState: 'needs_login',
      binaryPath,
      evidence: 'local_spike',
    });

    mocks.authenticated.add('qoderclicn');
    sources = await new AgentEngineRegistry({ cacheTtlMs: 0 }).listSources();
    expect(sources.find((source) => source.manifestId === 'qoder_work')).toMatchObject({
      detected: true,
      selectable: false,
      authState: 'authenticated',
      binaryPath,
      evidence: 'local_spike',
    });
  });
});

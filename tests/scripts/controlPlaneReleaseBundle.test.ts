import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCanonicalContentHash,
  buildControlPlaneReleaseBundle,
} from '../../scripts/control-plane-release-bundle.mjs';

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withRegistryTrust<T extends Record<string, unknown>>(registry: T, expiresAt = '2099-12-31T23:59:59.000Z'): T {
  const trusted = {
    ...registry,
    source: {
      ...((registry.source as Record<string, unknown> | undefined) ?? {}),
      expiresAt,
    },
  };
  return {
    ...trusted,
    source: {
      ...(trusted.source as Record<string, unknown>),
      contentHash: buildCanonicalContentHash(trusted),
    },
  } as T;
}

function installableCapability(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mcp-template:test',
    kind: 'mcp_template',
    name: 'Test MCP',
    install: {
      mcpServer: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@example/mcp'],
      },
    },
    ...overrides,
  };
}

function agentEngineCatalog(version = '2026.05.17') {
  return {
    version,
    updatedAt: '2026-05-17T00:00:00.000Z',
    engines: [{
      kind: 'codex_cli',
      defaultModel: 'gpt-5',
      models: [{
        id: 'gpt-5',
        label: 'GPT-5',
        capabilities: ['code', 'reasoning'],
      }],
    }],
  };
}

function writeSource(dir: string, options: {
  version?: string;
  channel?: string;
  promptKeys?: Record<string, string>;
  capabilities?: unknown[];
  revokedIds?: string[];
} = {}) {
  writeJson(join(dir, 'cloud-config.json'), {
    version: options.version ?? '2026.05.17',
    prompts: {},
    skills: [],
    toolMeta: {},
    featureFlags: {},
    uiStrings: { zh: {}, en: {} },
    rules: {},
    mcpServers: [],
    entitlement: {
      status: 'active',
      plan: 'release-test',
      capabilities: ['*'],
    },
    release: options.channel ? { channel: options.channel } : {},
  });
  writeJson(join(dir, 'prompt-registry.json'), {
    version: options.version ?? '2026.05.17',
    prompts: options.promptKeys ?? {
      policyAddon: 'Follow signed policy.',
      publicSystemAddon: 'Use public addendum.',
    },
  });
  writeJson(join(dir, 'capability-registry.json'), withRegistryTrust({
    version: options.version ?? '2026.05.17',
    items: options.capabilities ?? [installableCapability()],
    revokedIds: options.revokedIds ?? [],
  }));
  writeJson(join(dir, 'agent-engine-model-catalog.json'), agentEngineCatalog(options.version ?? '2026.05.17'));
  writeJson(join(dir, 'renderer-bundle-rollout.json'), {
    version: options.version ?? '2026.05.17',
    channel: options.channel ?? 'stable',
    rolloutPercent: 100,
  });
  writeFileSync(join(dir, 'public.pem'), '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n');
}

describe('control-plane release bundle', () => {
  it('generates normalized payloads, manifest, and safe env commands', () => {
    const source = makeDir('code-agent-control-plane-release-source-');
    const out = makeDir('code-agent-control-plane-release-out-');
    writeSource(source);

    const result = buildControlPlaneReleaseBundle({
      sourceDir: source,
      outDir: out,
      version: '2026.05.17',
      channel: 'stable',
      keyId: 'production-2026-05-17',
      now: new Date('2026-05-17T00:00:00.000Z'),
    });

    expect(result.rollbackAvailable).toBe(false);
    const cloudConfig = JSON.parse(readFileSync(join(out, 'cloud-config.json'), 'utf8')) as {
      release: { channel: string };
    };
    expect(cloudConfig.release.channel).toBe('stable');

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
      schemaVersion: number;
      version: string;
      channel: string;
      keyId: string;
      createdAt: string;
      artifacts: Array<{ fileName: string; contentHash: string }>;
      previousVersion: string | null;
      rollbackAvailable: boolean;
    };
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      version: '2026.05.17',
      channel: 'stable',
      keyId: 'production-2026-05-17',
      createdAt: '2026-05-17T00:00:00.000Z',
      previousVersion: null,
      rollbackAvailable: false,
    });
    expect(manifest.artifacts.map((artifact) => artifact.fileName)).toEqual([
      'cloud-config.json',
      'prompt-registry.json',
      'capability-registry.json',
      'agent-engine-model-catalog.json',
      'renderer-bundle-rollout.json',
    ]);
    expect(manifest.artifacts.every((artifact) => /^sha256:[a-f0-9]{64}$/.test(artifact.contentHash))).toBe(true);

    const commands = readFileSync(join(out, 'vercel-env-commands.txt'), 'utf8');
    expect(commands).toContain(`cd '${process.cwd()}'`);
    expect(commands).toContain('CONTROL_PLANE_CLOUD_CONFIG_JSON');
    expect(commands).toContain('CONTROL_PLANE_PROMPT_REGISTRY_JSON');
    expect(commands).toContain('CONTROL_PLANE_CAPABILITY_REGISTRY_JSON');
    expect(commands).toContain('CONTROL_PLANE_AGENT_ENGINE_MODEL_CATALOG_JSON');
    expect(commands).toContain('CONTROL_PLANE_RENDERER_BUNDLE_ROLLOUT_JSON');
    expect(commands).toContain(`CONTROL_PLANE_KEY_ID production --force --yes < '${out}/control-plane-key-id.txt'`);
    expect(commands).toContain(`CODE_AGENT_CONTROL_PLANE_KEY_ID production --force --yes < '${out}/control-plane-key-id.txt'`);
    expect(commands).toContain(`CONTROL_PLANE_TTL_SECONDS production --force --yes < '${out}/control-plane-ttl-seconds.txt'`);
    expect(commands).toContain('CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY');
    expect(commands).not.toContain('CONTROL_PLANE_PRIVATE_KEY');
    expect(commands).not.toContain('CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY');
    expect(commands).not.toContain('--value');
    expect(commands).not.toContain('BEGIN PRIVATE KEY');
    expect(readFileSync(join(out, 'control-plane-key-id.txt'), 'utf8')).toBe('production-2026-05-17\n');
    expect(readFileSync(join(out, 'control-plane-ttl-seconds.txt'), 'utf8')).toBe('3600\n');

    const postApplyCommands = readFileSync(join(out, 'post-apply-commands.txt'), 'utf8');
    expect(postApplyCommands).toContain(`cd '${process.cwd()}'`);
    expect(postApplyCommands).toContain('vercel deploy --prod --yes');
    expect(postApplyCommands).toContain('npm run renderer:verify-production -- --expected-version-from-app-update --include-remote-snapshot --retry-attempts 12 --retry-delay-ms 30000');
    expect(postApplyCommands).not.toContain('BEGIN PRIVATE KEY');
  });

  it('rejects dangerous prompt registry keys', () => {
    const source = makeDir('code-agent-control-plane-release-source-');
    const out = makeDir('code-agent-control-plane-release-out-');
    writeSource(source, {
      promptKeys: {
        policyAddon: 'safe',
        fullSystemPrompt: 'dangerous replacement',
      },
    });

    expect(() => buildControlPlaneReleaseBundle({
      sourceDir: source,
      outDir: out,
      version: '2026.05.17',
      channel: 'stable',
      keyId: 'production-2026-05-17',
      now: new Date('2026-05-17T00:00:00.000Z'),
    })).toThrow(/unsupported prompt keys: fullSystemPrompt/);
  });

  it('rejects duplicate capability ids', () => {
    const source = makeDir('code-agent-control-plane-release-source-');
    const out = makeDir('code-agent-control-plane-release-out-');
    writeSource(source, {
      capabilities: [
        installableCapability(),
        installableCapability({ name: 'Duplicate MCP' }),
      ],
    });

    expect(() => buildControlPlaneReleaseBundle({
      sourceDir: source,
      outDir: out,
      version: '2026.05.17',
      channel: 'stable',
      keyId: 'production-2026-05-17',
      now: new Date('2026-05-17T00:00:00.000Z'),
    })).toThrow(/Duplicate capability id: mcp-template:test/);
  });

  it('rejects installable MCP registry entries with missing or mismatched trust metadata', () => {
    const missingTrustSource = makeDir('code-agent-control-plane-release-source-');
    const out = makeDir('code-agent-control-plane-release-out-');
    writeJson(join(missingTrustSource, 'cloud-config.json'), {
      version: '2026.05.17',
      entitlement: { status: 'active', plan: 'release-test', capabilities: ['*'] },
    });
    writeJson(join(missingTrustSource, 'prompt-registry.json'), {
      version: '2026.05.17',
      prompts: { policyAddon: 'safe' },
    });
    writeJson(join(missingTrustSource, 'capability-registry.json'), {
      source: {
        contentHash: 'sha256:bad',
      },
      items: [
        {
          id: 'mcp-template:missing-trust',
          kind: 'mcp_template',
          install: {
            mcpServer: { type: 'stdio', command: 'npx' },
          },
        },
      ],
      revokedIds: [],
    });
    writeJson(join(missingTrustSource, 'agent-engine-model-catalog.json'), agentEngineCatalog());
    writeJson(join(missingTrustSource, 'renderer-bundle-rollout.json'), {
      version: '2026.05.17',
      channel: 'stable',
      rolloutPercent: 100,
    });
    writeFileSync(join(missingTrustSource, 'public.pem'), '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n');

    expect(() => buildControlPlaneReleaseBundle({
      sourceDir: missingTrustSource,
      outDir: out,
      version: '2026.05.17',
      channel: 'stable',
      keyId: 'production-2026-05-17',
      now: new Date('2026-05-17T00:00:00.000Z'),
    })).toThrow(/source.expiresAt is required/);

    const mismatchedTrustSource = makeDir('code-agent-control-plane-release-source-');
    writeJson(join(mismatchedTrustSource, 'cloud-config.json'), {
      version: '2026.05.17',
      entitlement: { status: 'active', plan: 'release-test', capabilities: ['*'] },
    });
    writeJson(join(mismatchedTrustSource, 'prompt-registry.json'), {
      version: '2026.05.17',
      prompts: { policyAddon: 'safe' },
    });
    writeJson(join(mismatchedTrustSource, 'capability-registry.json'), {
      source: {
        expiresAt: '2099-12-31T23:59:59.000Z',
        contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
      items: [
        installableCapability(),
      ],
      revokedIds: [],
    });
    writeJson(join(mismatchedTrustSource, 'agent-engine-model-catalog.json'), agentEngineCatalog());
    writeJson(join(mismatchedTrustSource, 'renderer-bundle-rollout.json'), {
      version: '2026.05.17',
      channel: 'stable',
      rolloutPercent: 100,
    });
    writeFileSync(join(mismatchedTrustSource, 'public.pem'), '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n');

    expect(() => buildControlPlaneReleaseBundle({
      sourceDir: mismatchedTrustSource,
      outDir: out,
      version: '2026.05.17',
      channel: 'stable',
      keyId: 'production-2026-05-17',
      now: new Date('2026-05-17T00:00:00.000Z'),
    })).toThrow(/source.contentHash mismatch/);
  });

  it('rejects installable MCP registry entries with executable env injection', () => {
    const source = makeDir('code-agent-control-plane-release-source-');
    const out = makeDir('code-agent-control-plane-release-out-');
    writeSource(source, {
      capabilities: [
        installableCapability({
          install: {
            mcpServer: {
              type: 'stdio',
              command: 'npx',
              env: {
                TOKEN: 'registry-secret',
              },
            },
          },
        }),
      ],
    });

    expect(() => buildControlPlaneReleaseBundle({
      sourceDir: source,
      outDir: out,
      version: '2026.05.17',
      channel: 'stable',
      keyId: 'production-2026-05-17',
      now: new Date('2026-05-17T00:00:00.000Z'),
    })).toThrow(/must not include env values/);
  });

  it('rejects ambiguous renderer rollout rollback payloads', () => {
    const source = makeDir('code-agent-control-plane-release-source-');
    const out = makeDir('code-agent-control-plane-release-out-');
    writeSource(source, { version: '2026.05.17', channel: 'stable' });
    writeJson(join(source, 'renderer-bundle-rollout.json'), {
      version: '2026.05.17',
      channel: 'latest',
      rolloutPercent: 100,
      rollbackToBuiltin: true,
      rollbackReason: 'temporary rollback',
    });

    expect(() => buildControlPlaneReleaseBundle({
      sourceDir: source,
      outDir: out,
      version: '2026.05.17',
      channel: 'stable',
      keyId: 'production-2026-05-17',
      now: new Date('2026-05-17T00:00:00.000Z'),
    })).toThrow(/rollbackToBuiltin requires rolloutPercent to be omitted or 0/);

    writeJson(join(source, 'renderer-bundle-rollout.json'), {
      version: '2026.05.17',
      channel: 'latest',
      rolloutPercent: 0,
      rollbackToBuiltin: true,
    });

    expect(() => buildControlPlaneReleaseBundle({
      sourceDir: source,
      outDir: out,
      version: '2026.05.17',
      channel: 'stable',
      keyId: 'production-2026-05-17',
      now: new Date('2026-05-17T00:00:00.000Z'),
    })).toThrow(/rollbackToBuiltin requires rollbackReason/);
  });

  it('writes rollback commands when previous bundle is provided', () => {
    const previousSource = makeDir('code-agent-control-plane-release-prev-source-');
    const previousOut = makeDir('code-agent-control-plane-release-prev-out-');
    writeSource(previousSource, { version: '2026.05.16', channel: 'stable' });
    buildControlPlaneReleaseBundle({
      sourceDir: previousSource,
      outDir: previousOut,
      version: '2026.05.16',
      channel: 'stable',
      keyId: 'production-2026-05-16',
      now: new Date('2026-05-16T00:00:00.000Z'),
    });

    const source = makeDir('code-agent-control-plane-release-source-');
    const out = makeDir('code-agent-control-plane-release-out-');
    writeSource(source, { version: '2026.05.17', channel: 'beta' });

    buildControlPlaneReleaseBundle({
      sourceDir: source,
      outDir: out,
      version: '2026.05.17',
      channel: 'beta',
      keyId: 'production-2026-05-17',
      previousDir: previousOut,
      now: new Date('2026-05-17T00:00:00.000Z'),
    });

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
      previousVersion: string;
      rollbackAvailable: boolean;
    };
    expect(manifest.previousVersion).toBe('2026.05.16');
    expect(manifest.rollbackAvailable).toBe(true);

    const rollbackCommands = readFileSync(join(out, 'rollback-env-commands.txt'), 'utf8');
    expect(rollbackCommands).toContain(`cd '${process.cwd()}'`);
    expect(rollbackCommands).toContain(`${previousOut}/cloud-config.json`);
    expect(rollbackCommands).toContain(`CONTROL_PLANE_KEY_ID production --force --yes < '${out}/rollback-control-plane-key-id.txt'`);
    expect(rollbackCommands).toContain(`CODE_AGENT_CONTROL_PLANE_KEY_ID production --force --yes < '${out}/rollback-control-plane-key-id.txt'`);
    expect(rollbackCommands).toContain(`CONTROL_PLANE_TTL_SECONDS production --force --yes < '${out}/control-plane-ttl-seconds.txt'`);
    expect(rollbackCommands).not.toContain('--value');
    expect(rollbackCommands).not.toContain('PRIVATE_KEY');
    expect(readFileSync(join(out, 'rollback-control-plane-key-id.txt'), 'utf8')).toBe('production-2026-05-16\n');
  });
});

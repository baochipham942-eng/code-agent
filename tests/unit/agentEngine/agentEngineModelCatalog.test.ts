import * as crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  discoverLocalAgentEngineModels,
  mergeAgentEngineModelCatalogWithDiscovery,
  parseClaudeHelpModelCatalog,
  parseAgentEngineModelCatalogPayload,
  parseCodexDebugModelsCatalog,
  parseJsonModelMapCatalog,
  parseGrokModelsCatalog,
  parseParenthesizedSupportedModelsCatalog,
  RemoteAgentEngineModelCatalogService,
  resolveAgentEngineCatalogModel,
} from '../../../src/host/services/agentEngine/agentEngineModelCatalog';
import type { AgentEngineModelDiscoveryResult } from '../../../src/host/services/agentEngine/agentEngineModelCatalog';
import { createControlPlaneEnvelope } from '../../../vercel-api/lib/controlPlaneEnvelope';
import { BUILTIN_AGENT_ENGINE_MODEL_CATALOG } from '../../../src/shared/agentEngineModelCatalog';

function createKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function makeCatalog(overrides: Record<string, unknown> = {}) {
  return {
    version: 'agent-engine-models-test',
    updatedAt: '2026-08-01T00:00:00.000Z',
    engines: [{
      kind: 'codex_cli',
      defaultModel: 'gpt-5',
      updatedAt: '2026-08-01T00:00:00.000Z',
      models: [{
        id: 'gpt-5',
        label: 'GPT-5',
        capabilities: ['code', 'reasoning'],
        recommended: true,
        updatedAt: '2026-08-01T00:00:00.000Z',
      }],
    }],
    ...overrides,
  };
}

function makeDiscovery(modelId: string): AgentEngineModelDiscoveryResult {
  return {
    engines: [{
      kind: 'codex_cli',
      defaultModel: modelId,
      updatedAt: '2026-08-27T00:00:00.000Z',
      models: [{
        id: modelId,
        label: modelId,
        capabilities: ['code'],
        recommended: true,
        updatedAt: '2026-08-27T00:00:00.000Z',
      }],
    }],
    diagnostics: [],
  };
}

describe('Agent Engine model catalog parser', () => {
  it('rejects duplicate model ids and falls back to the bundled catalog', () => {
    const parsed = parseAgentEngineModelCatalogPayload(makeCatalog({
      engines: [{
        kind: 'codex_cli',
        defaultModel: 'gpt-5',
        models: [
          { id: 'gpt-5', label: 'GPT-5', capabilities: ['code'] },
          { id: 'gpt-5', label: 'Duplicate GPT-5', capabilities: ['reasoning'] },
        ],
      }],
    }));

    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate_model', severity: 'error' }),
    ]));
    expect(parsed.catalog.version).toBe('builtin-2026-07-08');
  });

  it('rejects engines whose default model is not listed', () => {
    const parsed = parseAgentEngineModelCatalogPayload(makeCatalog({
      engines: [{
        kind: 'claude_code',
        defaultModel: 'opus',
        models: [{ id: 'sonnet', label: 'Claude Sonnet', capabilities: ['code'] }],
      }],
    }));

    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'default_model_not_found', severity: 'error' }),
    ]));
    expect(parsed.catalog.version).toBe('builtin-2026-07-08');
  });

  it('keeps disabled models visible but resolves execution to an enabled fallback', () => {
    const parsed = parseAgentEngineModelCatalogPayload(makeCatalog({
      engines: [{
        kind: 'codex_cli',
        defaultModel: 'gpt-5',
        models: [
          { id: 'gpt-5', label: 'GPT-5', capabilities: ['code'] },
          { id: 'gpt-5-retired', label: 'GPT-5 retired', capabilities: ['code'], disabledReason: '下架' },
        ],
      }],
    }));

    expect(parsed.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(parsed.catalog.engines[0].models[1].disabledReason).toBe('下架');
    expect(resolveAgentEngineCatalogModel(parsed.catalog, 'codex_cli', 'gpt-5-retired')?.id).toBe('gpt-5');
  });

  it('accepts mimo_code and kimi_code engine kinds', () => {
    const parsed = parseAgentEngineModelCatalogPayload(makeCatalog({
      engines: [
        {
          kind: 'mimo_code',
          defaultModel: 'mimo-coder',
          models: [{ id: 'mimo-coder', label: 'MiMo Coder', capabilities: ['code'] }],
        },
        {
          kind: 'kimi_code',
          defaultModel: 'kimi-k2.5',
          models: [{ id: 'kimi-k2.5', label: 'Kimi K2.5', capabilities: ['code'] }],
        },
      ],
    }));

    expect(parsed.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(parsed.catalog.engines.map((engine) => engine.kind)).toEqual(['mimo_code', 'kimi_code']);
  });
});

describe('local Agent Engine model discovery parsing', () => {
  it('starts every independent local model probe before waiting for the slowest one', async () => {
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const probes = [0, 1, 2].map((index) => async () => {
      started.push(index);
      await new Promise<void>((resolve) => releases.push(resolve));
      return makeDiscovery(`model-${index}`);
    });

    const discovery = discoverLocalAgentEngineModels(0, { probes });
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    releases.forEach((release) => release());

    await expect(discovery).resolves.toMatchObject({
      engines: [
        { defaultModel: 'model-0' },
        { defaultModel: 'model-1' },
        { defaultModel: 'model-2' },
      ],
    });
  });

  it('parses Codex CLI debug model JSON into a catalog engine', () => {
    const engine = parseCodexDebugModelsCatalog(JSON.stringify({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
        { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list' },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' },
      ],
    }), '2026-07-08T00:00:00.000Z');

    expect(engine).toMatchObject({
      kind: 'codex_cli',
      defaultModel: 'gpt-5.5',
      models: [
        expect.objectContaining({ id: 'gpt-5.5', label: 'GPT-5.5', recommended: true }),
        expect.objectContaining({ id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' }),
      ],
    });
    expect(engine?.models.map((model) => model.id)).not.toContain('codex-auto-review');
  });

  it('parses Claude Code model aliases from the installed CLI help text', () => {
    const engine = parseClaudeHelpModelCatalog(`
      --model <model>                       Model for the current session. Provide
                                            an alias for the latest model (e.g.
                                            'fable', 'opus', or 'sonnet') or a
                                            model's full name (e.g.
                                            'claude-fable-5').
      --name <name>                         Set a display name
    `, '2026-07-08T00:00:00.000Z');

    expect(engine?.kind).toBe('claude_code');
    expect(engine?.defaultModel).toBe('sonnet');
    expect(engine?.models.map((model) => model.id)).toEqual(['sonnet', 'fable', 'opus']);
    expect(engine?.models.find((model) => model.id === 'fable')?.label).toBe('Claude Fable (latest alias)');
  });

  it('parses the WorkBuddy CLI model list and keeps the client-default option', () => {
    const engine = parseParenthesizedSupportedModelsCatalog(
      'codebuddy_code',
      '--model <model> Model ID. Currently supported: (auto, hy4-preview, glm-5.1, kimi-k2.5)',
      'Currently supported:',
      '2026-08-29T00:00:00.000Z',
      'client_default',
    );

    expect(engine?.kind).toBe('codebuddy_code');
    expect(engine?.defaultModel).toBe('client_default');
    expect(engine?.models.map((model) => model.id)).toEqual([
      'client_default',
      'auto',
      'hy4-preview',
      'glm-5.1',
      'kimi-k2.5',
    ]);
    expect(engine?.models[0].label).toBe('客户端默认模型');
    expect(engine?.models[1].label).toBe('Auto（客户端自适应）');
  });

  it('parses the official Kimi provider model map and preserves the configured default', () => {
    const engine = parseJsonModelMapCatalog(
      'kimi_code',
      JSON.stringify({
        providers: {
          'managed:kimi-code': {
            apiKey: 'must-not-be-read',
          },
        },
        models: {
          'kimi-code/kimi-for-coding': {
            provider: 'managed:kimi-code',
            model: 'kimi-for-coding',
            displayName: 'K2.7 Coding',
          },
          'kimi-code/k3': {
            provider: 'kimi-code-key',
            model: 'k3',
            displayName: 'K3',
          },
        },
      }),
      'models',
      'displayName',
      '2026-07-30T00:00:00.000Z',
      'kimi-code/k3',
    );

    expect(engine).toMatchObject({
      kind: 'kimi_code',
      defaultModel: 'kimi-code/k3',
      models: [
        expect.objectContaining({ id: 'kimi-code/kimi-for-coding', label: 'K2.7 Coding' }),
        expect.objectContaining({ id: 'kimi-code/k3', label: 'K3' }),
      ],
    });
    expect(JSON.stringify(engine)).not.toContain('must-not-be-read');
  });

  it('parses only models returned by the official Grok CLI', () => {
    const engine = parseGrokModelsCatalog(`
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
`, '2026-07-30T00:00:00.000Z');

    expect(engine).toMatchObject({
      kind: 'grok_cli',
      defaultModel: 'grok-4.5',
      models: [
        expect.objectContaining({
          id: 'grok-4.5',
          label: 'Grok 4.5',
          recommended: true,
        }),
      ],
    });
  });

  it('merges discovered models before bundled fallback models', () => {
    const merged = mergeAgentEngineModelCatalogWithDiscovery(
      BUILTIN_AGENT_ENGINE_MODEL_CATALOG,
      {
        engines: [{
          kind: 'claude_code',
          defaultModel: 'fable',
          updatedAt: '2026-07-08T00:00:00.000Z',
          models: [{
            id: 'fable',
            label: 'Claude Fable (latest alias)',
            capabilities: ['code', 'reasoning', 'longContext'],
            recommended: true,
            updatedAt: '2026-07-08T00:00:00.000Z',
          }],
        }],
        diagnostics: [],
      },
      '2026-07-08T00:00:00.000Z',
    );
    const claude = merged.engines.find((engine) => engine.kind === 'claude_code');

    expect(merged.version).toBe('local-discovery-2026-07-08');
    expect(claude?.defaultModel).toBe('fable');
    expect(claude?.models[0].id).toBe('fable');
    expect(claude?.models.map((model) => model.id)).toEqual(expect.arrayContaining(['sonnet', 'fable', 'opus', 'haiku']));
  });

});

describe('bundled Agent Engine model catalog', () => {
  it('registers only safe bundled fallbacks and leaves Kimi/WorkBuddy to local discovery', () => {
    const parsed = parseAgentEngineModelCatalogPayload(BUILTIN_AGENT_ENGINE_MODEL_CATALOG, { sourcePath: 'bundled' });
    expect(parsed.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(parsed.catalog.engines.map((engine) => engine.kind)).toEqual(
      expect.arrayContaining(['codex_cli', 'claude_code', 'mimo_code']),
    );
    expect(parsed.catalog.engines.map((engine) => engine.kind)).not.toContain('kimi_code');
    expect(parsed.catalog.engines.map((engine) => engine.kind)).not.toContain('codebuddy_code');
    expect(parsed.catalog.engines.map((engine) => engine.kind)).not.toContain('grok_cli');

    // 未指定模型时回退到 defaultModel；指定时透传用户选择（resolveModelId 的核心路径）
    expect(resolveAgentEngineCatalogModel(parsed.catalog, 'mimo_code', null)?.id).toBe('mimo-coder');
    expect(resolveAgentEngineCatalogModel(parsed.catalog, 'mimo_code', 'mimo-coder')?.id).toBe('mimo-coder');
    expect(resolveAgentEngineCatalogModel(parsed.catalog, 'kimi_code', null)).toBeNull();
  });

  it('keeps Claude Code current aliases available in the bundled fallback', () => {
    const parsed = parseAgentEngineModelCatalogPayload(BUILTIN_AGENT_ENGINE_MODEL_CATALOG, { sourcePath: 'bundled' });
    const claude = parsed.catalog.engines.find((engine) => engine.kind === 'claude_code');

    expect(claude?.models.map((model) => model.id)).toEqual(expect.arrayContaining([
      'sonnet',
      'fable',
      'opus',
      'haiku',
    ]));
    expect(resolveAgentEngineCatalogModel(parsed.catalog, 'claude_code', 'fable')?.id).toBe('fable');
  });
});

describe('RemoteAgentEngineModelCatalogService', () => {
  it('coalesces concurrent cold readers into one local discovery round', async () => {
    let releaseDiscovery: (() => void) | undefined;
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    const localDiscoveryProvider = vi.fn(async () => {
      markDiscoveryStarted();
      await new Promise<void>((resolve) => { releaseDiscovery = resolve; });
      return makeDiscovery('coalesced-model');
    });
    const service = new RemoteAgentEngineModelCatalogService({ localDiscoveryProvider });

    const reads = [service.readCatalog(), service.readCatalog(), service.readCatalog()];
    await discoveryStarted;
    expect(localDiscoveryProvider).toHaveBeenCalledTimes(1);
    releaseDiscovery?.();
    const results = await Promise.all(reads);

    expect(results.map((result) => result.catalog.engines
      .find((engine) => engine.kind === 'codex_cli')?.defaultModel))
      .toEqual(['coalesced-model', 'coalesced-model', 'coalesced-model']);
  });

  it('starts cache freshness after slow discovery completes', async () => {
    let nowMs = 0;
    const localDiscoveryProvider = vi.fn(async () => {
      nowMs += 8_000;
      return makeDiscovery('slow-model');
    });
    const service = new RemoteAgentEngineModelCatalogService({
      localDiscoveryCacheTtlMs: 5_000,
      localDiscoveryProvider,
      nowProvider: () => nowMs,
    });

    await service.readCatalog();
    await service.readCatalog();

    expect(localDiscoveryProvider).toHaveBeenCalledTimes(1);
  });

  it('keeps the default local discovery cache warm for five minutes', async () => {
    let nowMs = 0;
    const localDiscoveryProvider = vi.fn(async () => makeDiscovery('warm-model'));
    const service = new RemoteAgentEngineModelCatalogService({
      localDiscoveryProvider,
      nowProvider: () => nowMs,
    });

    await service.readCatalog();
    nowMs = 60_001;
    await service.readCatalog();

    expect(localDiscoveryProvider).toHaveBeenCalledTimes(1);
  });

  it('serves stale catalog immediately while an expired entry revalidates in background', async () => {
    let nowMs = 0;
    let discoveryRound = 0;
    let releaseRefresh: (() => void) | undefined;
    // 后台重验什么时候开始由 provider 自己报，不靠计时器猜：
    // 09-05 门下 4 分片满载时，「排空一次定时器」不够等到它。
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    const localDiscoveryProvider = vi.fn(async () => {
      discoveryRound += 1;
      if (discoveryRound === 2) {
        markRefreshStarted();
        await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      }
      return makeDiscovery(`model-${discoveryRound}`);
    });
    const service = new RemoteAgentEngineModelCatalogService({
      localDiscoveryCacheTtlMs: 5,
      localDiscoveryProvider,
      nowProvider: () => nowMs,
    });

    const first = await service.readCatalog();
    nowMs = 6;
    const stale = await service.readCatalog();

    expect(stale).toBe(first);
    await refreshStarted;
    expect(localDiscoveryProvider).toHaveBeenCalledTimes(2);
    releaseRefresh?.();
    await vi.waitFor(async () => {
      const refreshed = await service.readCatalog();
      expect(refreshed.catalog.engines.find((engine) => engine.kind === 'codex_cli')?.defaultModel)
        .toBe('model-2');
    }, { timeout: 15_000, interval: 20 });
  });

  it('waits for fresh catalog after explicit invalidation', async () => {
    let discoveryRound = 0;
    let releaseRefresh: (() => void) | undefined;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    const localDiscoveryProvider = vi.fn(async () => {
      discoveryRound += 1;
      if (discoveryRound === 2) {
        markRefreshStarted();
        await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      }
      return makeDiscovery(`manual-model-${discoveryRound}`);
    });
    const service = new RemoteAgentEngineModelCatalogService({ localDiscoveryProvider });
    await service.readCatalog();

    service.invalidate();
    let settled = false;
    const refreshed = service.readCatalog().finally(() => { settled = true; });
    await refreshStarted;
    expect(localDiscoveryProvider).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    releaseRefresh?.();

    await expect(refreshed).resolves.toMatchObject({
      catalog: {
        engines: expect.arrayContaining([
          expect.objectContaining({ kind: 'codex_cli', defaultModel: 'manual-model-2' }),
        ]),
      },
    });
  });

  it('accepts a signed, non-expired remote catalog', async () => {
    const keys = createKeyPair();
    const payload = makeCatalog();
    const envelope = createControlPlaneEnvelope({
      kind: 'agent_engine_model_catalog',
      payload,
      keyId: 'agent-engine-test-key',
      privateKey: keys.privateKeyPem,
      issuedAt: '2026-05-22T00:00:00.000Z',
      expiresAt: '2099-12-31T23:59:59.000Z',
    });
    const service = new RemoteAgentEngineModelCatalogService({
      controlPlanePublicKeys: { 'agent-engine-test-key': keys.publicKeyPem },
      endpoint: 'https://control-plane.test/api/v1/control-plane?artifact=agent_engine_models',
      now: Date.parse('2026-05-22T00:00:00.000Z'),
      fetchImpl: async () => new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      disableLocalDiscovery: true,
    });

    const result = await service.readCatalog();

    expect(result).toMatchObject({
      source: 'remote',
      keyId: 'agent-engine-test-key',
      catalog: {
        version: 'agent-engine-models-test',
      },
    });
    expect(result.contentHash).toMatch(/^sha256:/);
  });

  it('overlays locally discovered engine models on top of the trusted catalog', async () => {
    const keys = createKeyPair();
    const payload = makeCatalog();
    const envelope = createControlPlaneEnvelope({
      kind: 'agent_engine_model_catalog',
      payload,
      keyId: 'agent-engine-test-key',
      privateKey: keys.privateKeyPem,
      issuedAt: '2026-07-08T00:00:00.000Z',
      expiresAt: '2099-12-31T23:59:59.000Z',
    });
    const service = new RemoteAgentEngineModelCatalogService({
      controlPlanePublicKeys: { 'agent-engine-test-key': keys.publicKeyPem },
      endpoint: 'https://control-plane.test/api/v1/control-plane?artifact=agent_engine_models',
      now: Date.parse('2026-07-08T00:00:00.000Z'),
      fetchImpl: async () => new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      localDiscoveryProvider: async () => ({
        engines: [{
          kind: 'claude_code',
          defaultModel: 'fable',
          updatedAt: '2026-07-08T00:00:00.000Z',
          models: [{
            id: 'fable',
            label: 'Claude Fable (latest alias)',
            capabilities: ['code', 'reasoning', 'longContext'],
            recommended: true,
            updatedAt: '2026-07-08T00:00:00.000Z',
          }],
        }],
        diagnostics: [],
      }),
    });

    const result = await service.readCatalog();
    const claude = result.catalog.engines.find((engine) => engine.kind === 'claude_code');

    expect(result.source).toBe('local_discovery');
    expect(result.keyId).toBe('agent-engine-test-key');
    expect(claude?.defaultModel).toBe('fable');
    expect(claude?.models.map((model) => model.id)).toContain('fable');
  });

  it('falls back to the bundled catalog when the signed envelope is expired', async () => {
    const keys = createKeyPair();
    const envelope = createControlPlaneEnvelope({
      kind: 'agent_engine_model_catalog',
      payload: makeCatalog(),
      keyId: 'agent-engine-test-key',
      privateKey: keys.privateKeyPem,
      issuedAt: '2026-05-22T00:00:00.000Z',
      expiresAt: '2026-05-22T00:00:01.000Z',
    });
    const service = new RemoteAgentEngineModelCatalogService({
      controlPlanePublicKeys: { 'agent-engine-test-key': keys.publicKeyPem },
      endpoint: 'https://control-plane.test/api/v1/control-plane?artifact=agent_engine_models',
      now: Date.parse('2026-05-22T00:00:02.000Z'),
      fetchImpl: async () => new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      disableLocalDiscovery: true,
    });

    const result = await service.readCatalog();

    expect(result.source).toBe('bundled');
    expect(result.catalog.version).toBe('builtin-2026-07-08');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'remote_expired_envelope' }),
    ]));
  });

  it('falls back to the bundled catalog when the signed remote catalog is older than bundled', async () => {
    const keys = createKeyPair();
    const envelope = createControlPlaneEnvelope({
      kind: 'agent_engine_model_catalog',
      payload: makeCatalog({ updatedAt: '2026-06-10T00:00:00.000Z' }),
      keyId: 'agent-engine-test-key',
      privateKey: keys.privateKeyPem,
      issuedAt: '2026-07-08T00:00:00.000Z',
      expiresAt: '2099-12-31T23:59:59.000Z',
    });
    const service = new RemoteAgentEngineModelCatalogService({
      controlPlanePublicKeys: { 'agent-engine-test-key': keys.publicKeyPem },
      endpoint: 'https://control-plane.test/api/v1/control-plane?artifact=agent_engine_models',
      now: Date.parse('2026-07-08T00:00:00.000Z'),
      fetchImpl: async () => new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      disableLocalDiscovery: true,
    });

    const result = await service.readCatalog();

    expect(result.source).toBe('bundled');
    expect(result.catalog.version).toBe('builtin-2026-07-08');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'remote_catalog_older_than_bundled', severity: 'warning' }),
    ]));
  });
});

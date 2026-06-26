import * as crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  parseAgentEngineModelCatalogPayload,
  RemoteAgentEngineModelCatalogService,
  resolveAgentEngineCatalogModel,
} from '../../../src/host/services/agentEngine/agentEngineModelCatalog';
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
    updatedAt: '2026-05-22T00:00:00.000Z',
    engines: [{
      kind: 'codex_cli',
      defaultModel: 'gpt-5',
      updatedAt: '2026-05-22T00:00:00.000Z',
      models: [{
        id: 'gpt-5',
        label: 'GPT-5',
        capabilities: ['code', 'reasoning'],
        recommended: true,
        updatedAt: '2026-05-22T00:00:00.000Z',
      }],
    }],
    ...overrides,
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
    expect(parsed.catalog.version).toBe('builtin-2026-05-25');
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
    expect(parsed.catalog.version).toBe('builtin-2026-05-25');
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

describe('bundled Agent Engine model catalog', () => {
  it('registers mimo_code and kimi_code with resolvable default models', () => {
    const parsed = parseAgentEngineModelCatalogPayload(BUILTIN_AGENT_ENGINE_MODEL_CATALOG, { sourcePath: 'bundled' });
    expect(parsed.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(parsed.catalog.engines.map((engine) => engine.kind)).toEqual(
      expect.arrayContaining(['codex_cli', 'claude_code', 'mimo_code', 'kimi_code']),
    );

    // 未指定模型时回退到 defaultModel；指定时透传用户选择（resolveModelId 的核心路径）
    expect(resolveAgentEngineCatalogModel(parsed.catalog, 'mimo_code', null)?.id).toBe('mimo-coder');
    expect(resolveAgentEngineCatalogModel(parsed.catalog, 'mimo_code', 'mimo-coder')?.id).toBe('mimo-coder');
    expect(resolveAgentEngineCatalogModel(parsed.catalog, 'kimi_code', null)?.id).toBe('kimi-k2.5');
    expect(resolveAgentEngineCatalogModel(parsed.catalog, 'kimi_code', 'kimi-k2.5')?.id).toBe('kimi-k2.5');
  });
});

describe('RemoteAgentEngineModelCatalogService', () => {
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
    });

    const result = await service.readCatalog();

    expect(result.source).toBe('bundled');
    expect(result.catalog.version).toBe('builtin-2026-05-25');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'remote_expired_envelope' }),
    ]));
  });
});

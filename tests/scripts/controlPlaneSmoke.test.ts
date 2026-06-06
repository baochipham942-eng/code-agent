import { describe, expect, it } from 'vitest';
import {
  buildControlPlaneContentHash,
  CONTROL_PLANE_ARTIFACTS,
  runControlPlaneSmoke,
} from '../../scripts/control-plane-smoke.mjs';

type MockResponse = {
  status: number;
  body: unknown;
};

function signedEnvelope(kind: string, payload: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    kind,
    issuedAt: '2026-05-17T00:00:00.000Z',
    expiresAt: '2099-12-31T23:59:59.000Z',
    contentHash: buildControlPlaneContentHash(payload),
    keyId: 'smoke-test-key',
    signature: Buffer.from(`signed:${kind}`).toString('base64'),
    payload,
  };
}

function response(status: number, body: unknown): MockResponse {
  return { status, body };
}

function mockFetch(fixtures: Record<string, MockResponse>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const href = url.toString();
    calls.push({ url: href, init: init ?? {} });
    const parsed = new URL(href);
    const key = `${parsed.pathname}${parsed.search}`;
    const fixture = fixtures[key];
    if (!fixture) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

describe('control-plane smoke script', () => {
  it('accepts signed envelopes from all required control-plane endpoints', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/api/v1/config': response(200, signedEnvelope('cloud_config', {
        version: 'cloud-config-test',
        prompts: {},
      })),
      '/api/prompts?gen=all': response(200, signedEnvelope('prompt_registry', {
        version: 'prompts-test',
        prompts: {},
      })),
      '/api/v1/control-plane?artifact=capabilities': response(200, signedEnvelope('capability_registry', {
        version: 'capabilities-test',
        items: [],
      })),
      '/api/v1/control-plane?artifact=agent_engine_models': response(200, signedEnvelope('agent_engine_model_catalog', {
        version: 'agent-engine-models-test',
        updatedAt: '2026-05-22T00:00:00.000Z',
        engines: [],
      })),
      '/api/v1/control-plane?artifact=renderer_bundle_rollout': response(200, signedEnvelope('renderer_bundle_rollout', {
        version: 'renderer-rollout-test',
        channel: 'beta',
      })),
    });

    const results = await runControlPlaneSmoke({
      baseUrl: 'https://control-plane.test',
      token: 'server-token',
      fetchImpl,
    });

    expect(results.map((result) => result.kind)).toEqual([
      'cloud_config',
      'prompt_registry',
      'capability_registry',
      'agent_engine_model_catalog',
      'renderer_bundle_rollout',
    ]);
    expect(calls.map((call) => new URL(call.url).pathname + new URL(call.url).search)).toEqual([
      '/api/v1/config',
      '/api/prompts?gen=all',
      '/api/v1/control-plane?artifact=capabilities',
      '/api/v1/control-plane?artifact=agent_engine_models',
      '/api/v1/control-plane?artifact=renderer_bundle_rollout',
    ]);
    expect(calls.every((call) => call.init.headers?.Authorization === 'Bearer server-token')).toBe(true);
  });

  it('reports control-plane configuration gaps from 503 unconfigured responses', async () => {
    const { fetchImpl } = mockFetch({
      '/api/v1/config': response(503, {
        error: 'control_plane_unconfigured',
        message: 'CONTROL_PLANE_PRIVATE_KEY is not configured.',
      }),
    });

    await expect(runControlPlaneSmoke({
      baseUrl: 'https://control-plane.test',
      fetchImpl,
      artifacts: [CONTROL_PLANE_ARTIFACTS[0]],
    })).rejects.toMatchObject({
      code: 'control_plane_unconfigured',
      message: expect.stringContaining('CONTROL_PLANE_PRIVATE_KEY is not configured'),
    });
  });

  it('reports unsupported artifacts from stale deployed control-plane code', async () => {
    const { fetchImpl } = mockFetch({
      '/api/v1/control-plane?artifact=renderer_bundle_rollout': response(400, {
        error: 'unsupported_artifact',
        message: 'Supported artifacts are cloud_config, capability_registry, agent_engine_model_catalog, and prompt_registry.',
      }),
    });

    await expect(runControlPlaneSmoke({
      baseUrl: 'https://control-plane.test',
      fetchImpl,
      artifacts: [CONTROL_PLANE_ARTIFACTS[4]],
    })).rejects.toMatchObject({
      code: 'unsupported_artifact',
      message: expect.stringContaining('is not supported by the deployed control-plane'),
    });
  });

  it('fails when an endpoint returns a different envelope kind', async () => {
    const { fetchImpl } = mockFetch({
      '/api/v1/config': response(200, signedEnvelope('prompt_registry', {
        version: 'wrong-kind-test',
      })),
    });

    await expect(runControlPlaneSmoke({
      baseUrl: 'https://control-plane.test',
      fetchImpl,
      artifacts: [CONTROL_PLANE_ARTIFACTS[0]],
    })).rejects.toMatchObject({
      code: 'kind_mismatch',
      message: expect.stringContaining('kind expected cloud_config'),
    });
  });

  it('fails when a successful envelope is missing its signature', async () => {
    const envelope = signedEnvelope('cloud_config', {
      version: 'missing-signature-test',
    });
    delete (envelope as { signature?: string }).signature;
    const { fetchImpl } = mockFetch({
      '/api/v1/config': response(200, envelope),
    });

    await expect(runControlPlaneSmoke({
      baseUrl: 'https://control-plane.test',
      fetchImpl,
      artifacts: [CONTROL_PLANE_ARTIFACTS[0]],
    })).rejects.toMatchObject({
      code: 'missing_signature',
      message: expect.stringContaining('signature is required'),
    });
  });
});

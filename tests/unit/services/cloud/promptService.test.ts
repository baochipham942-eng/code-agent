import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import type { ControlPlaneEnvelope } from '../../../../src/shared/contract/controlPlane';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
} from '../../../../src/main/services/cloud/controlPlaneTrust';

vi.mock('../../../../src/main/prompts/builder', () => ({
  SYSTEM_PROMPT: 'builtin prompt',
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockFetch = vi.fn();

function mockJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: () => null,
    },
    json: async () => body,
  };
}

function buildSignedPromptRegistry(
  payload: { version: string; prompts: Record<string, string> },
  options: { expiresAt?: string } = {},
) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope: ControlPlaneEnvelope<typeof payload> = {
    schemaVersion: 1,
    kind: 'prompt_registry',
    issuedAt: '2026-05-17T00:00:00.000Z',
    expiresAt: options.expiresAt ?? '2099-12-31T23:59:59.000Z',
    contentHash: buildControlPlaneContentHash(payload),
    keyId: 'prompt-test-key',
    payload,
  };
  envelope.signature = crypto.sign(
    null,
    Buffer.from(buildControlPlaneSigningPayload(envelope)),
    privateKey,
  ).toString('base64');
  return {
    envelope,
    publicKeys: {
      'prompt-test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

async function loadPromptService() {
  vi.resetModules();
  global.fetch = mockFetch;
  return import('../../../../src/main/services/cloud/promptService');
}

describe('promptService control-plane trust', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CODE_AGENT_ALLOW_UNSIGNED_PROMPTS;
    global.fetch = mockFetch;
  });

  it('rejects unsigned prompt registries and keeps builtin source', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      version: 'unsigned-prompts',
      prompts: { policyAddon: 'unsigned addon', gen8: 'remote prompt' },
    }));
    const { initPromptService, getPromptsInfo } = await loadPromptService();
    const { listTrustedRemotePromptFragments } = await import('../../../../src/main/prompts/remoteFragments');

    await initPromptService();

    expect(getPromptsInfo()).toMatchObject({
      source: 'builtin',
      version: null,
      trust: {
        trusted: false,
        diagnostics: [
          expect.objectContaining({ code: 'missing_control_plane_envelope' }),
        ],
      },
    });
    expect(listTrustedRemotePromptFragments()).toEqual([]);
  });

  it('accepts signed prompt registry envelopes with a configured public key', async () => {
    const payload = {
      version: 'signed-prompts',
      prompts: {
        policyAddon: 'signed policy addon',
        publicSystemAddon: 'signed public addon',
        gen8: 'remote full replacement must be ignored by prompt builder',
      },
    };
    const { envelope, publicKeys } = buildSignedPromptRegistry(payload);
    mockFetch.mockResolvedValueOnce(mockJsonResponse(envelope));
    const { initPromptService, getPromptsInfo } = await loadPromptService();
    const { listTrustedRemotePromptFragments } = await import('../../../../src/main/prompts/remoteFragments');

    await initPromptService({ controlPlanePublicKeys: publicKeys });

    expect(getPromptsInfo()).toMatchObject({
      source: 'cloud',
      version: 'signed-prompts',
      trust: {
        trusted: true,
        keyId: 'prompt-test-key',
        expiresAt: '2099-12-31T23:59:59.000Z',
        diagnostics: [],
      },
    });
    expect(listTrustedRemotePromptFragments()).toEqual([
      { id: 'policyAddon', text: 'signed policy addon' },
      { id: 'publicSystemAddon', text: 'signed public addon' },
    ]);
  });

  it('ignores expired signed registries and keeps local prompt fallback', async () => {
    const payload = {
      version: 'expired-prompts',
      prompts: { policyAddon: 'expired addon' },
    };
    const { envelope, publicKeys } = buildSignedPromptRegistry(payload, {
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    mockFetch.mockResolvedValueOnce(mockJsonResponse(envelope));
    const { initPromptService, getPromptsInfo, getSystemPrompt } = await loadPromptService();
    const { listTrustedRemotePromptFragments } = await import('../../../../src/main/prompts/remoteFragments');

    await initPromptService({ controlPlanePublicKeys: publicKeys });

    expect(getPromptsInfo()).toMatchObject({
      source: 'builtin',
      version: null,
      trust: {
        trusted: false,
      },
    });
    expect(listTrustedRemotePromptFragments()).toEqual([]);
    expect(getSystemPrompt()).toBe('builtin prompt');
  });

  it('sends a bearer token when fetching prompt registry', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      version: 'unsigned-dev-prompts',
      prompts: { gen8: 'remote prompt' },
    }));
    const { initPromptService } = await loadPromptService();

    await initPromptService({
      allowUnsignedPrompts: true,
      getAccessToken: async () => 'short-lived-token',
    });

    expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer short-lived-token',
      }),
    }));
  });
});

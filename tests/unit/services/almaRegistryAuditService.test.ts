import { describe, expect, it, vi } from 'vitest';
import { refreshAlmaRegistryAudit } from '../../../src/main/services/almaRegistry/almaRegistryAuditService';
import {
  ALMA_MCP_REGISTRY_URL,
  ALMA_PLUGIN_REGISTRY_URL,
} from '../../../src/shared/constants/almaRegistryAudit';

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
  } as Response;
}

describe('refreshAlmaRegistryAudit', () => {
  it('fetches Alma registries and returns drift reports without installing anything', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === ALMA_MCP_REGISTRY_URL) {
        return jsonResponse({
          version: '1.1.0',
          servers: [
            { id: 'context7', name: 'Context7', featured: true },
            { id: 'new-docs', name: 'New Docs', featured: true },
          ],
        });
      }
      if (url === ALMA_PLUGIN_REGISTRY_URL) {
        return jsonResponse({
          version: '1.0.0',
          plugins: [
            { id: 'token-counter', name: 'Token Counter', type: 'ui', featured: true },
            { id: 'slash-tools', name: 'Slash Tools', type: 'command', featured: true },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await refreshAlmaRegistryAudit({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-06-14T00:00:00.000Z'),
    });

    expect(fetchImpl).toHaveBeenCalledWith(ALMA_MCP_REGISTRY_URL, expect.any(Object));
    expect(fetchImpl).toHaveBeenCalledWith(ALMA_PLUGIN_REGISTRY_URL, expect.any(Object));
    expect(result.fetchedAt).toBe('2026-06-14T00:00:00.000Z');
    expect(result.mcp.drift).toMatchObject({
      status: 'changed',
      addedFeaturedIds: ['new-docs'],
    });
    expect(result.plugin.drift).toMatchObject({
      status: 'changed',
      addedFeaturedIds: ['slash-tools'],
    });
  });

  it('fails closed when a registry request is not successful', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response));

    await expect(refreshAlmaRegistryAudit({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow('HTTP 503');
  });
});

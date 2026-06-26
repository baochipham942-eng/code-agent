import {
  ALMA_MCP_REGISTRY_URL,
  ALMA_PLUGIN_REGISTRY_URL,
  ALMA_REVIEWED_MCP_REGISTRY_AUDIT,
  ALMA_REVIEWED_PLUGIN_REGISTRY_AUDIT,
  buildAlmaMcpRegistryAudit,
  buildAlmaPluginRegistryAudit,
  buildAlmaRegistryDriftReport,
  type AlmaRegistryAuditRefreshResult,
} from '../../../shared/constants/almaRegistryAudit';
import type { AlmaMcpRegistryPayload } from '../../../shared/constants/almaMcpRegistry';
import type { AlmaPluginRegistryPayload } from '../../../shared/constants/almaPluginRegistry';

export interface AlmaRegistryAuditRefreshOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
): Promise<T> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function refreshAlmaRegistryAudit(
  options: AlmaRegistryAuditRefreshOptions = {},
): Promise<AlmaRegistryAuditRefreshResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this runtime');
  }

  const [mcpPayload, pluginPayload] = await Promise.all([
    fetchJson<AlmaMcpRegistryPayload>(fetchImpl, ALMA_MCP_REGISTRY_URL),
    fetchJson<AlmaPluginRegistryPayload>(fetchImpl, ALMA_PLUGIN_REGISTRY_URL),
  ]);
  const currentMcp = buildAlmaMcpRegistryAudit(mcpPayload);
  const currentPlugin = buildAlmaPluginRegistryAudit(pluginPayload);

  return {
    fetchedAt: (options.now?.() ?? new Date()).toISOString(),
    mcp: {
      reviewed: ALMA_REVIEWED_MCP_REGISTRY_AUDIT,
      current: currentMcp,
      drift: buildAlmaRegistryDriftReport(ALMA_REVIEWED_MCP_REGISTRY_AUDIT, currentMcp),
    },
    plugin: {
      reviewed: ALMA_REVIEWED_PLUGIN_REGISTRY_AUDIT,
      current: currentPlugin,
      drift: buildAlmaRegistryDriftReport(ALMA_REVIEWED_PLUGIN_REGISTRY_AUDIT, currentPlugin),
    },
  };
}

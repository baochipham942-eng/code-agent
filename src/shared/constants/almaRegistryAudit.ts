import {
  ALMA_MCP_FEATURED_FALLBACK,
  ALMA_MCP_REGISTRY_REVIEWED_AT,
  type AlmaMcpRegistryPayload,
} from './almaMcpRegistry';
import {
  ALMA_FEATURED_PLUGIN_REGISTRY,
  ALMA_PLUGIN_REGISTRY_REVIEWED_AT,
  type AlmaPluginRegistryPayload,
} from './almaPluginRegistry';

export const ALMA_MCP_REGISTRY_URL = 'https://ravitemer.github.io/mcp-registry/registry.json';
export const ALMA_PLUGIN_REGISTRY_URL = 'https://raw.githubusercontent.com/yetone/alma-plugins/main/registry.json';

export type AlmaRegistryKind = 'mcp' | 'plugin';

export interface AlmaRegistryAuditSnapshot {
  kind: AlmaRegistryKind;
  sourceUrl: string;
  reviewedAt: string;
  version?: string;
  totalItems: number;
  featuredIds: string[];
  defaultFlagMatches: string[];
  snapshotFingerprint: string;
}

export interface AlmaRegistryDriftReport {
  kind: AlmaRegistryKind;
  status: 'unchanged' | 'changed';
  changedFields: string[];
  addedFeaturedIds: string[];
  removedFeaturedIds: string[];
  defaultFlagMatches: string[];
}

export interface AlmaRegistryAuditRefreshResult {
  fetchedAt: string;
  mcp: {
    reviewed: AlmaRegistryAuditSnapshot;
    current: AlmaRegistryAuditSnapshot;
    drift: AlmaRegistryDriftReport;
  };
  plugin: {
    reviewed: AlmaRegistryAuditSnapshot;
    current: AlmaRegistryAuditSnapshot;
    drift: AlmaRegistryDriftReport;
  };
}

const REVIEWED_MCP_TOTAL = 37;
const REVIEWED_PLUGIN_TOTAL = 8;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  const text = stableJson(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function collectDefaultFlagMatches(
  items: Array<Record<string, unknown>>,
): string[] {
  return items
    .filter((item) => item.default === true || item.isDefault === true || item.builtin === true)
    .map((item) => normalizeId(item.id) || normalizeId(item.name) || 'unknown')
    .filter((id): id is string => Boolean(id));
}

function makeAuditSnapshot(args: Omit<AlmaRegistryAuditSnapshot, 'snapshotFingerprint'>): AlmaRegistryAuditSnapshot {
  const featuredIds = [...args.featuredIds];
  const defaultFlagMatches = [...args.defaultFlagMatches];
  return {
    ...args,
    featuredIds,
    defaultFlagMatches,
    snapshotFingerprint: fingerprint({
      kind: args.kind,
      version: args.version || '',
      totalItems: args.totalItems,
      featuredIds,
      defaultFlagMatches,
    }),
  };
}

export const ALMA_REVIEWED_MCP_REGISTRY_AUDIT: AlmaRegistryAuditSnapshot = makeAuditSnapshot({
  kind: 'mcp',
  sourceUrl: ALMA_MCP_REGISTRY_URL,
  reviewedAt: ALMA_MCP_REGISTRY_REVIEWED_AT,
  version: '1.0.0',
  totalItems: REVIEWED_MCP_TOTAL,
  featuredIds: ALMA_MCP_FEATURED_FALLBACK.map((server) => server.id),
  defaultFlagMatches: [],
});

export const ALMA_REVIEWED_PLUGIN_REGISTRY_AUDIT: AlmaRegistryAuditSnapshot = makeAuditSnapshot({
  kind: 'plugin',
  sourceUrl: ALMA_PLUGIN_REGISTRY_URL,
  reviewedAt: ALMA_PLUGIN_REGISTRY_REVIEWED_AT,
  version: '1.0.0',
  totalItems: REVIEWED_PLUGIN_TOTAL,
  featuredIds: ALMA_FEATURED_PLUGIN_REGISTRY.map((plugin) => plugin.id),
  defaultFlagMatches: [],
});

export function buildAlmaMcpRegistryAudit(
  payload?: AlmaMcpRegistryPayload,
): AlmaRegistryAuditSnapshot {
  if (!Array.isArray(payload?.servers)) {
    return ALMA_REVIEWED_MCP_REGISTRY_AUDIT;
  }

  const servers = payload.servers;
  return makeAuditSnapshot({
    kind: 'mcp',
    sourceUrl: ALMA_MCP_REGISTRY_URL,
    reviewedAt: ALMA_MCP_REGISTRY_REVIEWED_AT,
    version: payload.version,
    totalItems: servers.length,
    featuredIds: servers
      .filter((server) => server.featured === true)
      .map((server) => normalizeId(server.id) || normalizeId(server.name))
      .filter((id): id is string => Boolean(id)),
    defaultFlagMatches: collectDefaultFlagMatches(servers as Array<Record<string, unknown>>),
  });
}

export function buildAlmaPluginRegistryAudit(
  payload?: AlmaPluginRegistryPayload,
): AlmaRegistryAuditSnapshot {
  if (!Array.isArray(payload?.plugins)) {
    return ALMA_REVIEWED_PLUGIN_REGISTRY_AUDIT;
  }

  const plugins = payload.plugins;
  return makeAuditSnapshot({
    kind: 'plugin',
    sourceUrl: ALMA_PLUGIN_REGISTRY_URL,
    reviewedAt: ALMA_PLUGIN_REGISTRY_REVIEWED_AT,
    version: payload.version,
    totalItems: plugins.length,
    featuredIds: plugins
      .filter((plugin) => plugin.featured === true)
      .map((plugin) => normalizeId(plugin.id) || normalizeId(plugin.name))
      .filter((id): id is string => Boolean(id)),
    defaultFlagMatches: collectDefaultFlagMatches(plugins as Array<Record<string, unknown>>),
  });
}

export function buildAlmaRegistryDriftReport(
  reviewed: AlmaRegistryAuditSnapshot,
  current: AlmaRegistryAuditSnapshot,
): AlmaRegistryDriftReport {
  const reviewedFeatured = new Set(reviewed.featuredIds);
  const currentFeatured = new Set(current.featuredIds);
  const addedFeaturedIds = current.featuredIds.filter((id) => !reviewedFeatured.has(id));
  const removedFeaturedIds = reviewed.featuredIds.filter((id) => !currentFeatured.has(id));
  const changedFields: string[] = [];

  if (reviewed.version !== current.version) {
    changedFields.push('version');
  }
  if (reviewed.totalItems !== current.totalItems) {
    changedFields.push('totalItems');
  }
  if (addedFeaturedIds.length || removedFeaturedIds.length) {
    changedFields.push('featuredIds');
  }
  if (current.defaultFlagMatches.length > 0) {
    changedFields.push('defaultFlagMatches');
  }

  return {
    kind: reviewed.kind,
    status: changedFields.length > 0 ? 'changed' : 'unchanged',
    changedFields,
    addedFeaturedIds,
    removedFeaturedIds,
    defaultFlagMatches: [...current.defaultFlagMatches],
  };
}

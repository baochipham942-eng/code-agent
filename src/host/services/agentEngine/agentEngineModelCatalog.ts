// ============================================================================
// Agent Engine model catalog reader
// ============================================================================

import type { ModelCapability } from '../../../shared/contract/model';
import type {
  AgentEngineModelCatalog,
  AgentEngineModelCatalogDiagnostic,
  AgentEngineModelCatalogEngine,
  AgentEngineModelCatalogModel,
  AgentEngineModelCatalogResult,
  ExternalAgentEngineKind,
} from '../../../shared/contract/agentEngine';
import { BUILTIN_AGENT_ENGINE_MODEL_CATALOG } from '../../../shared/agentEngineModelCatalog';
import { CLOUD, CLOUD_ENDPOINTS } from '../../../shared/constants';
import {
  getControlPlanePublicKeysFromEnv,
  isControlPlaneEnvelope,
  verifyControlPlaneEnvelope,
  type ControlPlanePublicKeys,
} from '../cloud/controlPlaneTrust';
import { StaleCatalogCache } from './staleCatalogCache';

import {
  cloneCatalog,
  diagnostic,
  discoverLocalAgentEngineModels,
  getNowIso,
  isRecord,
  logger,
  mergeAgentEngineModelCatalogWithDiscovery,
  readString,
  type AgentEngineModelDiscoveryProvider,
} from './agentEngineModelDiscovery';

export type { AgentEngineModelDiscoveryResult } from './agentEngineModelDiscovery';
export type { AgentEngineModelDiscoveryProvider } from './agentEngineModelDiscovery';
export { parseCodexDebugModelsCatalog } from './agentEngineModelDiscovery';
export { parseClaudeHelpModelCatalog } from './agentEngineModelDiscovery';
export { parseParenthesizedSupportedModelsCatalog } from './agentEngineModelDiscovery';
export { parseJsonModelMapCatalog } from './agentEngineModelDiscovery';
export { parseGrokModelsCatalog } from './agentEngineModelDiscovery';
export { mergeAgentEngineModelCatalogWithDiscovery } from './agentEngineModelDiscovery';
export { discoverLocalAgentEngineModels } from './agentEngineModelDiscovery';

const EXTERNAL_AGENT_ENGINE_KINDS = new Set<ExternalAgentEngineKind>([
  'codex_cli',
  'claude_code',
  'mimo_code',
  'kimi_code',
  'codebuddy_code',
  'grok_cli',
  'dsh_cli',
]);
const MODEL_CAPABILITIES = new Set<ModelCapability>([
  'code',
  'vision',
  'fast',
  'reasoning',
  'gui',
  'general',
  'search',
  'compact',
  'quick',
  'longContext',
  'unlimited',
]);
// Local CLI installs, logins, and configured defaults change much less often than the model
// picker is opened. Manual engine detection invalidates this cache and still waits for fresh
// facts; ordinary reads can serve the last catalog while this TTL is revalidated.
const LOCAL_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

export interface RemoteAgentEngineModelCatalogServiceOptions {
  controlPlanePublicKeys?: ControlPlanePublicKeys;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  nowProvider?: () => number;
  localDiscoveryProvider?: AgentEngineModelDiscoveryProvider;
  disableLocalDiscovery?: boolean;
  localDiscoveryCacheTtlMs?: number;
}

interface ParseAgentEngineModelCatalogOptions {
  sourcePath?: string;
}

interface ParseAgentEngineModelCatalogResult {
  catalog: AgentEngineModelCatalog;
  diagnostics: AgentEngineModelCatalogDiagnostic[];
}

function normalizeDateString(value: unknown, fallback: string): string {
  const raw = readString(value);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : fallback;
}

function normalizeCapabilities(value: unknown): ModelCapability[] {
  if (!Array.isArray(value)) {
    return ['code'];
  }
  const capabilities = value
    .filter((entry): entry is ModelCapability =>
      typeof entry === 'string' && MODEL_CAPABILITIES.has(entry as ModelCapability)
    );
  return capabilities.length > 0 ? [...new Set(capabilities)] : ['code'];
}

function hasPublicKeys(keys: ControlPlanePublicKeys): boolean {
  return Object.keys(keys).length > 0;
}

function defaultAgentEngineModelCatalogEndpoint(): string {
  const override = process.env.CODE_AGENT_AGENT_ENGINE_MODEL_CATALOG_URL
    || process.env.CONTROL_PLANE_AGENT_ENGINE_MODEL_CATALOG_URL;
  if (override?.trim()) {
    return override.trim();
  }
  return `${CLOUD_ENDPOINTS.baseUrl}/api/v1/control-plane?artifact=agent_engine_models`;
}

function catalogUpdatedAtMs(catalog: AgentEngineModelCatalog): number {
  const updatedAtMs = Date.parse(catalog.updatedAt);
  return Number.isFinite(updatedAtMs) ? updatedAtMs : 0;
}

function isOlderThanBundledCatalog(catalog: AgentEngineModelCatalog): boolean {
  return catalogUpdatedAtMs(catalog) < catalogUpdatedAtMs(BUILTIN_AGENT_ENGINE_MODEL_CATALOG);
}

function parseModel(
  value: unknown,
  path: string,
  fallbackUpdatedAt: string,
): { model?: AgentEngineModelCatalogModel; diagnostics: AgentEngineModelCatalogDiagnostic[] } {
  const diagnostics: AgentEngineModelCatalogDiagnostic[] = [];
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('invalid_model', 'Agent Engine catalog model must be an object.', { path }));
    return { diagnostics };
  }

  const id = readString(value.id);
  const label = readString(value.label);
  if (!id) {
    diagnostics.push(diagnostic('missing_model_id', 'Agent Engine catalog model requires id.', { path }));
  }
  if (!label) {
    diagnostics.push(diagnostic('missing_model_label', 'Agent Engine catalog model requires label.', { path }));
  }
  if (!id || !label) {
    return { diagnostics };
  }

  return {
    model: {
      id,
      label,
      capabilities: normalizeCapabilities(value.capabilities),
      ...(value.recommended === true ? { recommended: true } : {}),
      ...(readString(value.disabledReason) ? { disabledReason: readString(value.disabledReason) ?? undefined } : {}),
      updatedAt: normalizeDateString(value.updatedAt, fallbackUpdatedAt),
    },
    diagnostics,
  };
}

function parseEngine(
  value: unknown,
  path: string,
  fallbackUpdatedAt: string,
): { engine?: AgentEngineModelCatalogEngine; diagnostics: AgentEngineModelCatalogDiagnostic[] } {
  const diagnostics: AgentEngineModelCatalogDiagnostic[] = [];
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('invalid_engine', 'Agent Engine catalog engine must be an object.', { path }));
    return { diagnostics };
  }

  const kind = readString(value.kind);
  if (!kind || !EXTERNAL_AGENT_ENGINE_KINDS.has(kind as ExternalAgentEngineKind)) {
    diagnostics.push(diagnostic(
      'invalid_engine_kind',
      'Agent Engine catalog engine kind must be codex_cli, claude_code, mimo_code, kimi_code, codebuddy_code, grok_cli, or dsh_cli.',
      { path: `${path}.kind` },
    ));
    return { diagnostics };
  }

  const defaultModel = readString(value.defaultModel);
  if (!defaultModel) {
    diagnostics.push(diagnostic('missing_default_model', 'Agent Engine catalog engine requires defaultModel.', { path: `${path}.defaultModel` }));
  }

  if (!Array.isArray(value.models)) {
    diagnostics.push(diagnostic('missing_models', 'Agent Engine catalog engine requires models array.', { path: `${path}.models` }));
    return { diagnostics };
  }

  const updatedAt = normalizeDateString(value.updatedAt, fallbackUpdatedAt);
  const modelIds = new Set<string>();
  const models: AgentEngineModelCatalogModel[] = [];
  value.models.forEach((modelValue, index) => {
    const parsed = parseModel(modelValue, `${path}.models[${index}]`, updatedAt);
    diagnostics.push(...parsed.diagnostics);
    if (!parsed.model) return;
    if (modelIds.has(parsed.model.id)) {
      diagnostics.push(diagnostic('duplicate_model', `Duplicate Agent Engine model id: ${parsed.model.id}.`, {
        path: `${path}.models[${index}].id`,
      }));
      return;
    }
    modelIds.add(parsed.model.id);
    models.push(parsed.model);
  });

  if (defaultModel && !models.some((model) => model.id === defaultModel)) {
    diagnostics.push(diagnostic('default_model_not_found', `Default model ${defaultModel} is not present in the engine catalog.`, {
      path: `${path}.defaultModel`,
    }));
  }
  const defaultEntry = models.find((model) => model.id === defaultModel);
  if (defaultEntry?.disabledReason) {
    diagnostics.push(diagnostic('default_model_disabled', `Default model ${defaultModel} is disabled in the engine catalog.`, {
      path: `${path}.defaultModel`,
      severity: 'warning',
    }));
  }

  if (!defaultModel || models.length === 0 || diagnostics.some((entry) => entry.severity === 'error')) {
    return { diagnostics };
  }

  return {
    engine: {
      kind: kind as ExternalAgentEngineKind,
      defaultModel,
      models,
      updatedAt,
    },
    diagnostics,
  };
}

export function parseAgentEngineModelCatalogPayload(
  value: unknown,
  options: ParseAgentEngineModelCatalogOptions = {},
): ParseAgentEngineModelCatalogResult {
  const sourcePath = options.sourcePath ?? 'agent_engine_model_catalog';
  const diagnostics: AgentEngineModelCatalogDiagnostic[] = [];
  if (!isRecord(value)) {
    return {
      catalog: cloneCatalog(BUILTIN_AGENT_ENGINE_MODEL_CATALOG),
      diagnostics: [diagnostic('invalid_catalog', 'Agent Engine model catalog must be an object.', { path: sourcePath })],
    };
  }

  const version = readString(value.version);
  if (!version) {
    diagnostics.push(diagnostic('missing_version', 'Agent Engine model catalog requires version.', { path: `${sourcePath}.version` }));
  }

  const updatedAt = normalizeDateString(value.updatedAt, new Date(0).toISOString());
  if (!Array.isArray(value.engines)) {
    diagnostics.push(diagnostic('missing_engines', 'Agent Engine model catalog requires engines array.', { path: `${sourcePath}.engines` }));
  }

  const engineKinds = new Set<ExternalAgentEngineKind>();
  const engines: AgentEngineModelCatalogEngine[] = [];
  if (Array.isArray(value.engines)) {
    value.engines.forEach((engineValue, index) => {
      const parsed = parseEngine(engineValue, `${sourcePath}.engines[${index}]`, updatedAt);
      diagnostics.push(...parsed.diagnostics);
      if (!parsed.engine) return;
      if (engineKinds.has(parsed.engine.kind)) {
        diagnostics.push(diagnostic('duplicate_engine', `Duplicate Agent Engine kind: ${parsed.engine.kind}.`, {
          path: `${sourcePath}.engines[${index}].kind`,
        }));
        return;
      }
      engineKinds.add(parsed.engine.kind);
      engines.push(parsed.engine);
    });
  }

  if (!version || engines.length === 0 || diagnostics.some((entry) => entry.severity === 'error')) {
    return {
      catalog: cloneCatalog(BUILTIN_AGENT_ENGINE_MODEL_CATALOG),
      diagnostics,
    };
  }

  return {
    catalog: {
      version,
      updatedAt,
      engines,
    },
    diagnostics,
  };
}

export function getAgentEngineCatalogEngine(
  catalog: AgentEngineModelCatalog,
  kind: ExternalAgentEngineKind,
): AgentEngineModelCatalogEngine | null {
  return catalog.engines.find((engine) => engine.kind === kind) ?? null;
}

/**
 * 显式请求的模型在目标引擎下不可用（不存在或已停用）时抛出。
 * 用于 run 派发路径的 fail-closed：绝不静默把请求模型替换成引擎默认模型。
 */
export class AgentEngineModelIncompatibleError extends Error {
  constructor(
    public readonly kind: ExternalAgentEngineKind,
    public readonly requestedModel: string,
  ) {
    super(`Model "${requestedModel}" is not available for the ${kind} agent engine.`);
    this.name = 'AgentEngineModelIncompatibleError';
  }
}

export interface ResolveAgentEngineCatalogModelOptions {
  /**
   * strict=true 时，显式请求的模型在该引擎下不可用就抛 AgentEngineModelIncompatibleError，
   * 绝不静默替换成引擎默认模型（run 派发路径用，避免"假装跑了 X 实际跑了 Y"）。
   * 未显式请求模型（requestedModel 为空）时仍回落默认模型，不受 strict 影响。
   */
  strict?: boolean;
}

export function resolveAgentEngineCatalogModel(
  catalog: AgentEngineModelCatalog,
  kind: ExternalAgentEngineKind,
  requestedModel?: string | null,
  options?: ResolveAgentEngineCatalogModelOptions,
): AgentEngineModelCatalogModel | null {
  const engine = getAgentEngineCatalogEngine(catalog, kind);
  if (!engine) {
    if (options?.strict && requestedModel) {
      throw new AgentEngineModelIncompatibleError(kind, requestedModel);
    }
    return null;
  }

  const enabledModels = engine.models.filter((model) => !model.disabledReason);
  const requested = requestedModel
    ? enabledModels.find((model) => model.id === requestedModel)
    : null;
  if (requested) {
    return requested;
  }

  // 显式请求了某模型但在该引擎下不可用 → fail-closed，绝不静默替换成默认模型。
  if (options?.strict && requestedModel) {
    throw new AgentEngineModelIncompatibleError(kind, requestedModel);
  }

  return enabledModels.find((model) => model.id === engine.defaultModel)
    ?? enabledModels[0]
    ?? null;
}

export class RemoteAgentEngineModelCatalogService {
  private options: RemoteAgentEngineModelCatalogServiceOptions;
  private readonly cache = new StaleCatalogCache<AgentEngineModelCatalogResult>();

  constructor(options: RemoteAgentEngineModelCatalogServiceOptions = {}) {
    this.options = options;
  }

  setOptions(options: RemoteAgentEngineModelCatalogServiceOptions): void {
    this.options = {
      ...this.options,
      ...options,
    };
    this.cache.invalidate();
  }

  invalidate(): void { this.cache.invalidate(); }

  async readCatalog(): Promise<AgentEngineModelCatalogResult> {
    return this.cache.read({
      now: () => this.currentTimeMs(),
      load: async () => {
        const base = await this.readTrustedOrBundledCatalog();
        return this.applyLocalDiscovery(base);
      },
      expiresAt: (result, loadedAt) => this.resolveCacheExpiresAtMs(result, loadedAt),
      canServeStale: (result, now) => {
        if (!result.expiresAt) return true;
        const trustExpiresAt = Date.parse(result.expiresAt);
        return !Number.isFinite(trustExpiresAt) || trustExpiresAt > now;
      },
      onBackgroundError: (error) => {
        logger.warn('Background Agent Engine model catalog refresh failed; keeping last known result', {
          detail: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  private currentTimeMs(): number { return this.options.nowProvider?.() ?? this.options.now ?? Date.now(); }

  private async readTrustedOrBundledCatalog(): Promise<AgentEngineModelCatalogResult> {
    const publicKeys = this.options.controlPlanePublicKeys || getControlPlanePublicKeysFromEnv();
    if (!hasPublicKeys(publicKeys)) {
      return this.bundledResult([
        diagnostic(
          'remote_catalog_public_keys_missing',
          'Skipped remote Agent Engine model catalog because no control-plane public keys are configured.',
          { severity: 'warning' },
        ),
      ]);
    }

    const endpoint = this.options.endpoint ?? defaultAgentEngineModelCatalogEndpoint();
    return this.fetchTrustedCatalog(endpoint, publicKeys);
  }

  private async applyLocalDiscovery(
    base: AgentEngineModelCatalogResult,
  ): Promise<AgentEngineModelCatalogResult> {
    if (this.options.disableLocalDiscovery) {
      return base;
    }

    const discover = this.options.localDiscoveryProvider
      ?? (() => discoverLocalAgentEngineModels(this.currentTimeMs()));
    const discovery = await discover();
    if (discovery.engines.length === 0) {
      return {
        ...base,
        diagnostics: [...discovery.diagnostics, ...base.diagnostics],
      };
    }

    return {
      catalog: mergeAgentEngineModelCatalogWithDiscovery(base.catalog, discovery, getNowIso(this.currentTimeMs())),
      source: 'local_discovery',
      diagnostics: [
        ...discovery.diagnostics,
        ...base.diagnostics.filter((entry) => entry.severity === 'error'),
      ],
      ...(base.contentHash ? { contentHash: base.contentHash } : {}),
      ...(base.keyId ? { keyId: base.keyId } : {}),
      ...(base.expiresAt ? { expiresAt: base.expiresAt } : {}),
    };
  }

  async resolveModelId(
    kind: ExternalAgentEngineKind,
    requestedModel?: string | null,
    options?: ResolveAgentEngineCatalogModelOptions,
  ): Promise<string | undefined> {
    const result = await this.readCatalog();
    return resolveAgentEngineCatalogModel(result.catalog, kind, requestedModel, options)?.id;
  }

  private resolveCacheExpiresAtMs(result: AgentEngineModelCatalogResult, now: number): number {
    const localTtl = this.options.localDiscoveryCacheTtlMs ?? LOCAL_DISCOVERY_CACHE_TTL_MS;
    const localExpiresAtMs = now + localTtl;
    if (result.source !== 'remote' || !result.expiresAt) {
      return localExpiresAtMs;
    }
    const expiresAtMs = Date.parse(result.expiresAt);
    return Number.isFinite(expiresAtMs) ? Math.min(expiresAtMs, localExpiresAtMs) : localExpiresAtMs;
  }

  private async fetchTrustedCatalog(
    endpoint: string,
    publicKeys: ControlPlanePublicKeys,
  ): Promise<AgentEngineModelCatalogResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), CLOUD.FETCH_TIMEOUT);
      const response = await (this.options.fetchImpl || fetch)(endpoint, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        return this.bundledResult([
          diagnostic(
            'remote_catalog_fetch_failed',
            `Skipped remote Agent Engine model catalog because the control plane returned HTTP ${response.status}.`,
            { path: endpoint, severity: 'warning' },
          ),
        ]);
      }

      const value: unknown = await response.json();
      if (!isControlPlaneEnvelope(value)) {
        return this.bundledResult([
          diagnostic(
            'remote_catalog_invalid_envelope',
            'Skipped remote Agent Engine model catalog because the response is not a signed control-plane envelope.',
            { path: endpoint },
          ),
        ]);
      }

      const trust = verifyControlPlaneEnvelope<AgentEngineModelCatalog>(value, {
        kind: 'agent_engine_model_catalog',
        publicKeys,
        requireSignature: true,
        now: this.currentTimeMs(),
      });
      if (!trust.trusted || !trust.payload) {
        return this.bundledResult(trust.diagnostics.map((entry) => diagnostic(
          `remote_${entry.code}`,
          entry.message,
          { path: endpoint, severity: entry.severity },
        )));
      }

      const parsed = parseAgentEngineModelCatalogPayload(trust.payload, { sourcePath: endpoint });
      if (parsed.diagnostics.some((entry) => entry.severity === 'error')) {
        return this.bundledResult(parsed.diagnostics);
      }
      if (isOlderThanBundledCatalog(parsed.catalog)) {
        return this.bundledResult([
          diagnostic(
            'remote_catalog_older_than_bundled',
            'Skipped remote Agent Engine model catalog because it is older than the bundled catalog.',
            { path: endpoint, severity: 'warning' },
          ),
        ]);
      }

      return {
        catalog: parsed.catalog,
        source: 'remote',
        diagnostics: parsed.diagnostics,
        ...(trust.contentHash ? { contentHash: trust.contentHash } : {}),
        ...(trust.keyId ? { keyId: trust.keyId } : {}),
        ...(trust.expiresAt ? { expiresAt: trust.expiresAt } : {}),
      };
    } catch (error) {
      logger.warn('Failed to fetch remote Agent Engine model catalog', { endpoint, error: String(error) });
      return this.bundledResult([
        diagnostic(
          'remote_catalog_fetch_failed',
          'Skipped remote Agent Engine model catalog because it could not be fetched.',
          { path: endpoint, severity: 'warning' },
        ),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private bundledResult(
    diagnostics: AgentEngineModelCatalogDiagnostic[] = [],
  ): AgentEngineModelCatalogResult {
    const parsed = parseAgentEngineModelCatalogPayload(BUILTIN_AGENT_ENGINE_MODEL_CATALOG, {
      sourcePath: 'bundled',
    });
    return {
      catalog: parsed.catalog,
      source: 'bundled',
      diagnostics: [...diagnostics, ...parsed.diagnostics],
    };
  }
}

let instance: RemoteAgentEngineModelCatalogService | null = null;

export function getRemoteAgentEngineModelCatalogService(): RemoteAgentEngineModelCatalogService {
  if (!instance) {
    instance = new RemoteAgentEngineModelCatalogService();
  }
  return instance;
}

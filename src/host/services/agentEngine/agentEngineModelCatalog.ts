// ============================================================================
// Agent Engine model catalog reader
// ============================================================================

import { execFile } from 'child_process';
import { promisify } from 'util';
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
import { createLogger } from '../infra/logger';
import { getShellPath } from '../infra/shellEnvironment';

const logger = createLogger('AgentEngineModelCatalog');
const execFileAsync = promisify(execFile);

const EXTERNAL_AGENT_ENGINE_KINDS = new Set<ExternalAgentEngineKind>(['codex_cli', 'claude_code', 'mimo_code', 'kimi_code']);
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
const LOCAL_DISCOVERY_TIMEOUT_MS = 8000;
const LOCAL_DISCOVERY_CACHE_TTL_MS = 60_000;
const CLAUDE_ALIAS_ORDER = ['sonnet', 'fable', 'opus', 'haiku'];
const CODEX_DEBUG_MODELS_MAX_BUFFER = 64 * 1024 * 1024;

export interface RemoteAgentEngineModelCatalogServiceOptions {
  controlPlanePublicKeys?: ControlPlanePublicKeys;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: number;
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

interface ExecProbeResult {
  stdout: string;
  stderr: string;
}

export interface AgentEngineModelDiscoveryResult {
  engines: AgentEngineModelCatalogEngine[];
  diagnostics: AgentEngineModelCatalogDiagnostic[];
}

export type AgentEngineModelDiscoveryProvider = () => Promise<AgentEngineModelDiscoveryResult>;

function diagnostic(
  code: string,
  message: string,
  extra: Partial<AgentEngineModelCatalogDiagnostic> = {},
): AgentEngineModelCatalogDiagnostic {
  return {
    severity: extra.severity ?? 'error',
    code,
    message,
    ...(extra.path ? { path: extra.path } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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

function cloneCatalog(catalog: AgentEngineModelCatalog): AgentEngineModelCatalog {
  return JSON.parse(JSON.stringify(catalog)) as AgentEngineModelCatalog;
}

function catalogUpdatedAtMs(catalog: AgentEngineModelCatalog): number {
  const updatedAtMs = Date.parse(catalog.updatedAt);
  return Number.isFinite(updatedAtMs) ? updatedAtMs : 0;
}

function isOlderThanBundledCatalog(catalog: AgentEngineModelCatalog): boolean {
  return catalogUpdatedAtMs(catalog) < catalogUpdatedAtMs(BUILTIN_AGENT_ENGINE_MODEL_CATALOG);
}

function getNowIso(now?: number): string {
  return new Date(now ?? Date.now()).toISOString();
}

function getProbeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: getShellPath(),
  };
}

async function resolveBinary(command: string): Promise<string | undefined> {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = await execFileAsync(locator, [command], {
      env: getProbeEnv(),
      timeout: LOCAL_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 128 * 1024,
    }) as ExecProbeResult;
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

function formatDiscoveredModelLabel(kind: ExternalAgentEngineKind, id: string): string {
  if (kind === 'claude_code') {
    const name = id
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    return name ? `Claude ${name} (latest alias)` : id;
  }

  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'gpt') return 'GPT';
      if (lower === 'codex') return 'Codex';
      if (lower === 'mimo') return 'MiMo';
      if (lower === 'kimi') return 'Kimi';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function inferAgentEngineModelCapabilities(
  kind: ExternalAgentEngineKind,
  modelId: string,
): ModelCapability[] {
  const id = modelId.toLowerCase();
  const capabilities = new Set<ModelCapability>(['code']);
  const fast = /mini|haiku|flash|spark|fast|lite|nano/.test(id);
  const reasoning = kind !== 'claude_code' || id !== 'haiku';

  if (reasoning) capabilities.add('reasoning');
  if (fast) capabilities.add('fast');
  if (
    kind === 'codex_cli'
    || kind === 'claude_code'
    || /long|1m|128k|200k|256k|sonnet|opus|fable|gpt|kimi/.test(id)
  ) {
    capabilities.add('longContext');
  }

  return Array.from(capabilities);
}

function normalizeDiscoveredModels(
  kind: ExternalAgentEngineKind,
  rawModels: Array<{ id: string; label?: string | null }>,
  updatedAt: string,
  preferredDefault?: string,
): AgentEngineModelCatalogEngine | null {
  const seen = new Set<string>();
  const models = rawModels
    .map((model) => ({
      id: model.id.trim(),
      label: model.label?.trim() || formatDiscoveredModelLabel(kind, model.id.trim()),
    }))
    .filter((model) => {
      if (!model.id || seen.has(model.id)) {
        return false;
      }
      seen.add(model.id);
      return true;
    })
    .map<AgentEngineModelCatalogModel>((model, index) => ({
      id: model.id,
      label: model.label,
      capabilities: inferAgentEngineModelCapabilities(kind, model.id),
      ...(index === 0 ? { recommended: true } : {}),
      updatedAt,
    }));

  if (models.length === 0) {
    return null;
  }

  const defaultModel = preferredDefault && models.some((model) => model.id === preferredDefault)
    ? preferredDefault
    : models[0].id;

  return {
    kind,
    defaultModel,
    models,
    updatedAt,
  };
}

function isVisibleCodexModel(value: Record<string, unknown>): boolean {
  const visibility = readString(value.visibility)?.toLowerCase();
  return visibility !== 'hide' && visibility !== 'hidden';
}

export function parseCodexDebugModelsCatalog(
  output: string,
  updatedAt = getNowIso(),
): AgentEngineModelCatalogEngine | null {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    return null;
  }

  const models = parsed.models
    .filter(isRecord)
    .filter(isVisibleCodexModel)
    .map((model) => ({
      id: readString(model.slug) ?? readString(model.id) ?? '',
      label: readString(model.display_name) ?? readString(model.name),
    }))
    .filter((model) => model.id);

  return normalizeDiscoveredModels('codex_cli', models, updatedAt);
}

function extractClaudeModelHelpSection(helpText: string): string {
  const lines = helpText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('--model <model>'));
  if (start < 0) return '';

  const section: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > start && /^\s{0,4}(?:-[\w-]|--[\w-])/.test(line)) {
      break;
    }
    section.push(line);
  }
  return section.join(' ');
}

function sortClaudeAliases(aliases: string[]): string[] {
  return aliases.sort((left, right) => {
    const leftIndex = CLAUDE_ALIAS_ORDER.indexOf(left);
    const rightIndex = CLAUDE_ALIAS_ORDER.indexOf(right);
    if (leftIndex >= 0 || rightIndex >= 0) {
      return (leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER)
        - (rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER);
    }
    return left.localeCompare(right);
  });
}

export function parseClaudeHelpModelCatalog(
  helpText: string,
  updatedAt = getNowIso(),
): AgentEngineModelCatalogEngine | null {
  const section = extractClaudeModelHelpSection(helpText);
  const aliasExample = section.match(/alias[\s\S]*?\((?:e\.g\.)?([\s\S]*?)\)/i)?.[1] ?? section;
  const aliases = Array.from(aliasExample.matchAll(/'([a-z][a-z0-9_-]*)'/gi))
    .map((match) => match[1].toLowerCase())
    .filter((id) => !id.startsWith('claude-'));
  const sortedAliases = sortClaudeAliases(Array.from(new Set(aliases)));

  return normalizeDiscoveredModels(
    'claude_code',
    sortedAliases.map((id) => ({ id })),
    updatedAt,
    sortedAliases.includes('sonnet') ? 'sonnet' : undefined,
  );
}

function mergeDiscoveredEngine(
  baseEngine: AgentEngineModelCatalogEngine | undefined,
  discoveredEngine: AgentEngineModelCatalogEngine,
): AgentEngineModelCatalogEngine {
  const baseModels = baseEngine?.models ?? [];
  const discoveredIds = new Set(discoveredEngine.models.map((model) => model.id));
  const models = [
    ...discoveredEngine.models.map((model) => {
      const existing = baseModels.find((entry) => entry.id === model.id);
      return {
        ...existing,
        ...model,
        capabilities: model.capabilities.length > 0
          ? model.capabilities
          : existing?.capabilities ?? ['code'],
        disabledReason: undefined,
      };
    }),
    ...baseModels.filter((model) => !discoveredIds.has(model.id)),
  ].map((model, index) => ({
    ...model,
    recommended: index === 0 ? true : model.recommended === true ? true : undefined,
  }));

  return {
    kind: discoveredEngine.kind,
    defaultModel: discoveredEngine.defaultModel || baseEngine?.defaultModel || models[0]?.id || '',
    models,
    updatedAt: discoveredEngine.updatedAt ?? baseEngine?.updatedAt,
  };
}

export function mergeAgentEngineModelCatalogWithDiscovery(
  base: AgentEngineModelCatalog,
  discovery: AgentEngineModelDiscoveryResult,
  updatedAt = getNowIso(),
): AgentEngineModelCatalog {
  if (discovery.engines.length === 0) {
    return cloneCatalog(base);
  }

  const discoveredByKind = new Map(discovery.engines.map((engine) => [engine.kind, engine]));
  const mergedKinds = new Set<ExternalAgentEngineKind>();
  const engines = base.engines.map((baseEngine) => {
    const discoveredEngine = discoveredByKind.get(baseEngine.kind);
    if (!discoveredEngine) {
      return baseEngine;
    }
    mergedKinds.add(baseEngine.kind);
    return mergeDiscoveredEngine(baseEngine, discoveredEngine);
  });

  for (const discoveredEngine of discovery.engines) {
    if (!mergedKinds.has(discoveredEngine.kind)) {
      engines.push(mergeDiscoveredEngine(undefined, discoveredEngine));
    }
  }

  return {
    version: `local-discovery-${updatedAt.slice(0, 10)}`,
    updatedAt,
    engines,
  };
}

export async function discoverLocalAgentEngineModels(now?: number): Promise<AgentEngineModelDiscoveryResult> {
  const updatedAt = getNowIso(now);
  const diagnostics: AgentEngineModelCatalogDiagnostic[] = [];
  const engines: AgentEngineModelCatalogEngine[] = [];

  const [codexBinary, claudeBinary] = await Promise.all([
    resolveBinary('codex'),
    resolveBinary('claude'),
  ]);

  if (codexBinary) {
    try {
      const result = await execFileAsync(codexBinary, ['debug', 'models'], {
        env: getProbeEnv(),
        timeout: LOCAL_DISCOVERY_TIMEOUT_MS,
        maxBuffer: CODEX_DEBUG_MODELS_MAX_BUFFER,
      }) as ExecProbeResult;
      const engine = parseCodexDebugModelsCatalog(result.stdout || result.stderr, updatedAt);
      if (engine) {
        engines.push(engine);
      }
    } catch (error) {
      diagnostics.push(diagnostic(
        'local_codex_model_discovery_failed',
        'Skipped local Codex model discovery because `codex debug models` failed.',
        { severity: 'warning', path: codexBinary },
      ));
      logger.warn('Failed to discover Codex CLI models', { error: String(error) });
    }
  }

  if (claudeBinary) {
    try {
      const result = await execFileAsync(claudeBinary, ['--help'], {
        env: getProbeEnv(),
        timeout: LOCAL_DISCOVERY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      }) as ExecProbeResult;
      const engine = parseClaudeHelpModelCatalog(`${result.stdout}\n${result.stderr}`, updatedAt);
      if (engine) {
        engines.push(engine);
      }
    } catch (error) {
      diagnostics.push(diagnostic(
        'local_claude_model_discovery_failed',
        'Skipped local Claude model discovery because `claude --help` failed.',
        { severity: 'warning', path: claudeBinary },
      ));
      logger.warn('Failed to discover Claude Code models', { error: String(error) });
    }
  }

  return { engines, diagnostics };
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
    diagnostics.push(diagnostic('invalid_engine_kind', 'Agent Engine catalog engine kind must be codex_cli, claude_code, mimo_code, or kimi_code.', { path: `${path}.kind` }));
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
  private cache: { result: AgentEngineModelCatalogResult; expiresAtMs: number } | null = null;

  constructor(options: RemoteAgentEngineModelCatalogServiceOptions = {}) {
    this.options = options;
  }

  setOptions(options: RemoteAgentEngineModelCatalogServiceOptions): void {
    this.options = {
      ...this.options,
      ...options,
    };
    this.cache = null;
  }

  invalidate(): void {
    this.cache = null;
  }

  async readCatalog(): Promise<AgentEngineModelCatalogResult> {
    if (this.cache && this.cache.expiresAtMs > (this.options.now ?? Date.now())) {
      return this.cache.result;
    }

    const base = await this.readTrustedOrBundledCatalog();
    const result = await this.applyLocalDiscovery(base);
    this.cache = {
      result,
      expiresAtMs: this.resolveCacheExpiresAtMs(result),
    };
    return result;
  }

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
      ?? (() => discoverLocalAgentEngineModels(this.options.now));
    const discovery = await discover();
    if (discovery.engines.length === 0) {
      return {
        ...base,
        diagnostics: [...discovery.diagnostics, ...base.diagnostics],
      };
    }

    return {
      catalog: mergeAgentEngineModelCatalogWithDiscovery(base.catalog, discovery, getNowIso(this.options.now)),
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

  private resolveCacheExpiresAtMs(result: AgentEngineModelCatalogResult): number {
    const now = this.options.now ?? Date.now();
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
        now: this.options.now,
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

import { execFile } from 'child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'util';
import type { ModelCapability } from '../../../shared/contract/model';
import type {
  AgentEngineModelCatalog,
  AgentEngineModelCatalogDiagnostic,
  AgentEngineModelCatalogEngine,
  AgentEngineModelCatalogModel,
  ExternalAgentEngineKind,
} from '../../../shared/contract/agentEngine';
import {
  getExternalEngineManifestForKind,
  listExternalEngineManifests,
  type ExternalEngineManifest,
} from '../../../shared/externalEngineManifest';
import { createLogger } from '../infra/logger';
import { getShellPath } from '../infra/shellEnvironment';

const logger = createLogger('AgentEngineModelCatalog');
const execFileAsync = promisify(execFile);

const LOCAL_DISCOVERY_TIMEOUT_MS = 8000;

const CLAUDE_ALIAS_ORDER = ['sonnet', 'fable', 'opus', 'haiku'];
const CODEX_DEBUG_MODELS_MAX_BUFFER = 64 * 1024 * 1024;

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

function cloneCatalog(catalog: AgentEngineModelCatalog): AgentEngineModelCatalog {
  return JSON.parse(JSON.stringify(catalog)) as AgentEngineModelCatalog;
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

async function resolveManifestBinary(manifest: ExternalEngineManifest): Promise<string | undefined> {
  if (!manifest.probe) return undefined;
  for (const candidate of [
    ...(manifest.probe.binaryPaths ?? []),
    ...manifest.probe.commands,
  ]) {
    if (candidate.startsWith('~/')) {
      const expanded = join(homedir(), candidate.slice(2));
      try {
        await access(expanded);
        return expanded;
      } catch {
        continue;
      }
    }
    if (isAbsolute(candidate)) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    const resolved = await resolveBinary(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

function formatDiscoveredModelLabel(kind: ExternalAgentEngineKind, id: string): string {
  if (id.toLowerCase() === 'auto') {
    return 'Auto（客户端自适应）';
  }
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
      if (lower === 'glm') return 'GLM';
      if (lower === 'minimax') return 'MiniMax';
      if (lower === 'deepseek') return 'DeepSeek';
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

export function parseParenthesizedSupportedModelsCatalog(
  kind: ExternalAgentEngineKind,
  helpText: string,
  marker: string,
  updatedAt = getNowIso(),
  preferredDefault?: string,
): AgentEngineModelCatalogEngine | null {
  const markerIndex = helpText.indexOf(marker);
  if (markerIndex < 0) return null;
  const afterMarker = helpText.slice(markerIndex + marker.length);
  const list = afterMarker.match(/\(([^)]+)\)/)?.[1];
  if (!list) return null;

  const discoveredModels = list
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^[a-z0-9][a-z0-9._-]*$/i.test(id))
    .map((id) => ({ id }));

  const models = kind === 'codebuddy_code' ? [{ id: 'client_default', label: '客户端默认模型' }, ...discoveredModels] : discoveredModels;

  return normalizeDiscoveredModels(kind, models, updatedAt, preferredDefault);
}

export function parseJsonModelMapCatalog(
  kind: ExternalAgentEngineKind,
  output: string,
  modelMapKey = 'models',
  labelField = 'displayName',
  updatedAt = getNowIso(),
  preferredDefault?: string,
): AgentEngineModelCatalogEngine | null {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || !isRecord(parsed[modelMapKey])) {
    return null;
  }

  const models = Object.entries(parsed[modelMapKey])
    .filter(([, value]) => isRecord(value))
    .map(([id, value]) => ({
      id,
      label: isRecord(value) ? readString(value[labelField]) : null,
    }));

  return normalizeDiscoveredModels(kind, models, updatedAt, preferredDefault);
}

export function parseGrokModelsCatalog(
  output: string,
  updatedAt = getNowIso(),
  preferredDefault?: string,
): AgentEngineModelCatalogEngine | null {
  const defaultModel = preferredDefault
    ?? output.match(/Default model:\s*([^\s]+)/i)?.[1]?.trim();
  const availableSection = output.split(/Available models:\s*/i)[1] ?? '';
  const models = availableSection
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\*\s+([a-z0-9][a-z0-9._-]*)/i)?.[1])
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id }));
  return normalizeDiscoveredModels('grok_cli', models, updatedAt, defaultModel);
}

function mergeDiscoveredEngine(
  baseEngine: AgentEngineModelCatalogEngine | undefined,
  discoveredEngine: AgentEngineModelCatalogEngine,
): AgentEngineModelCatalogEngine {
  const mergeMode = getExternalEngineManifestForKind(discoveredEngine.kind)
    ?.probe?.modelDiscovery?.merge ?? 'overlay';
  const baseModels = mergeMode === 'replace' ? [] : baseEngine?.models ?? [];
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

async function discoverCodexModels(updatedAt: string): Promise<AgentEngineModelDiscoveryResult> {
  const diagnostics: AgentEngineModelCatalogDiagnostic[] = [];
  const engines: AgentEngineModelCatalogEngine[] = [];

  const codexBinary = await resolveBinary('codex');

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

  return { engines, diagnostics };
}

async function discoverClaudeModels(updatedAt: string): Promise<AgentEngineModelDiscoveryResult> {
  const diagnostics: AgentEngineModelCatalogDiagnostic[] = [];
  const engines: AgentEngineModelCatalogEngine[] = [];
  const claudeBinary = await resolveBinary('claude');

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

async function discoverConfiguredManifestModels(
  manifest: ExternalEngineManifest & { kind: ExternalAgentEngineKind },
  updatedAt: string,
): Promise<AgentEngineModelDiscoveryResult> {
  const diagnostics: AgentEngineModelCatalogDiagnostic[] = [];
  const engines: AgentEngineModelCatalogEngine[] = [];
  const discovery = manifest.probe?.modelDiscovery;
  if (!discovery) return { engines, diagnostics };

  const binary = await resolveManifestBinary(manifest);
  if (!binary) return { engines, diagnostics };

  try {
    const modelProbe = execFileAsync(binary, discovery.args, {
      env: getProbeEnv(),
      timeout: LOCAL_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }) as Promise<ExecProbeResult>;
    const defaultModelProbe = discovery.defaultModelProbe
      ? (execFileAsync(binary, discovery.defaultModelProbe.args, {
          env: getProbeEnv(),
          timeout: LOCAL_DISCOVERY_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        }) as Promise<ExecProbeResult>).catch(() => {
          diagnostics.push(diagnostic(
            `local_${manifest.kind}_default_model_discovery_failed`,
            `The installed ${manifest.label} client did not return its configured default model.`,
            { severity: 'warning', path: binary },
          ));
          return undefined;
        })
      : Promise.resolve(undefined);

    const [result, defaultResult] = await Promise.all([modelProbe, defaultModelProbe]);
    const output = `${result.stdout}\n${result.stderr}`;
    let preferredDefault = discovery.preferredDefault;
    if (defaultResult && discovery.defaultModelProbe) {
      const match = `${defaultResult.stdout}\n${defaultResult.stderr}`
        .match(new RegExp(discovery.defaultModelProbe.pattern, 'i'));
      preferredDefault = match?.[1]?.trim() || preferredDefault;
    }
    const engine = discovery.parser === 'supported_models_parenthesized'
      ? parseParenthesizedSupportedModelsCatalog(
          manifest.kind,
          output,
          discovery.marker ?? '',
          updatedAt,
          preferredDefault,
        )
      : discovery.parser === 'model_map_json'
        ? parseJsonModelMapCatalog(
            manifest.kind,
            output,
            discovery.modelMapKey,
            discovery.labelField,
            updatedAt,
            preferredDefault,
          )
        : parseGrokModelsCatalog(output, updatedAt, preferredDefault);
    if (engine) {
      engines.push(engine);
    } else {
      diagnostics.push(diagnostic(
        `local_${manifest.kind}_model_discovery_empty`,
        `The installed ${manifest.label} client did not return a parseable model catalog.`,
        { severity: 'warning', path: binary },
      ));
    }
  } catch (error) {
    diagnostics.push(diagnostic(
      `local_${manifest.kind}_model_discovery_failed`,
      `Skipped local ${manifest.label} model discovery because its configured probe failed.`,
      { severity: 'warning', path: binary },
    ));
    logger.warn(`Failed to discover ${manifest.label} models`, { error: String(error) });
  }

  return { engines, diagnostics };
}

export async function discoverLocalAgentEngineModels(
  now?: number,
  /** Deterministic probe seam for timing tests and the repeatable perf harness. */
  options: { probes?: readonly AgentEngineModelDiscoveryProvider[] } = {},
): Promise<AgentEngineModelDiscoveryResult> {
  const updatedAt = getNowIso(now);

  const configuredDiscoveries = listExternalEngineManifests()
    .filter((manifest): manifest is ExternalEngineManifest & { kind: ExternalAgentEngineKind } =>
      Boolean(
        manifest.kind
        && manifest.kind !== 'native'
        && manifest.probe?.modelDiscovery,
      ));
  const probes = options.probes ?? [
    () => discoverCodexModels(updatedAt),
    () => discoverClaudeModels(updatedAt),
    ...configuredDiscoveries.map((manifest) => (
      () => discoverConfiguredManifestModels(manifest, updatedAt)
    )),
  ];
  const results = await Promise.all(probes.map((probe) => probe()));

  return {
    engines: results.flatMap((result) => result.engines),
    diagnostics: results.flatMap((result) => result.diagnostics),
  };
}

export {
  cloneCatalog,
  diagnostic,
  getNowIso,
  isRecord,
  logger,
  readString,
};

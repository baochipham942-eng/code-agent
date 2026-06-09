import type { ControlPlaneArtifactKind } from './controlPlaneEnvelope.js';
import type { ControlPlaneRequestLike } from './controlPlaneEnvelope.js';
import * as crypto from 'node:crypto';
import { applyServerEntitlementGate, applyServerEntitlementGateAsync } from './controlPlaneEntitlements.js';
import { applyRendererBundleAutoRollbackGuard } from './controlPlaneRendererRollout.js';
import { loadSharedServiceKeysFromStore } from './controlPlaneSharedServiceKeys.js';
import { loadSharedProvidersFromStore } from './controlPlaneSharedProviders.js';
import { readJsonPayloadFromEnv } from './controlPlaneEnvelope.js';

/**
 * 团队共享 provider（中转站）下发配置。
 * 让管理员把一把中转站 key 通过控制面下发给被授权的用户，用户零配置即可在模型选择器里
 * 看到并使用这些模型——key 永远不进客户端构建包，只随 cloud_config 信封按 subject 下发。
 *
 * - `requiredCapability` 缺省 → team-wide：所有「通过鉴权」的用户都能拿到（开放给大家）。
 * - `requiredCapability` 指定（如 'shared_relay'）→ 仅 entitlement.capabilities 命中的用户能拿到，
 *   其余用户在网关层就被剥离整条配置（含 apiKey），密钥不下发。
 */
export interface SharedProviderConfig {
  /** provider id，必须是动态 custom provider 形态（custom-xxx），客户端据此注入选择器。 */
  id: string;
  /** 选择器里展示的分组名，例如「团队共享」。 */
  displayName: string;
  /** 中转站 OpenAI 兼容端点，例如 https://tokenflux.dev/v1。 */
  baseUrl: string;
  /** 中转站 key（机密）。仅下发给被授权 subject。 */
  apiKey: string;
  /** 协议，缺省 openai。 */
  protocol?: 'openai' | 'claude';
  /** 计费方式（影响自动模式路由），中转站默认 unknown。 */
  billingMode?: 'free' | 'plan' | 'payg' | 'unknown';
  /** 暴露给用户的模型白名单（由管理员在控制面/中转站侧策展）。 */
  models: Array<{ id: string; label?: string }>;
  /** entitlement 能力门；缺省=team-wide（所有鉴权用户），指定=仅命中该 capability 的用户。 */
  requiredCapability?: string;
}

export type SharedServiceKeyName = 'brave' | 'exa' | 'openai' | 'perplexity' | 'tavily';

/**
 * 团队共享服务 key（先用于搜索）。key 只随签名 cloud_config 下发给有权 subject，
 * 客户端把它作为本地未自配该服务 key 时的 fallback。
 */
export interface SharedServiceKeyConfig {
  service: SharedServiceKeyName;
  apiKey: string;
  /** Stable non-secret id derived from the service key; used for ops/quota state, never for auth. */
  keyId?: string;
  /** Optional OpenAI-compatible base URL, used when a service key belongs to a relay/NewAPI endpoint. */
  baseUrl?: string;
  displayName?: string;
  requiredCapability?: string;
}

export interface CloudConfigPayload {
  version: string;
  prompts: Record<string, string>;
  skills: unknown[];
  toolMeta: Record<string, unknown>;
  featureFlags: Record<string, boolean | number | string>;
  uiStrings: {
    zh: Record<string, string>;
    en: Record<string, string>;
  };
  rules: Record<string, string>;
  mcpServers: unknown[];
  /** Skill 推荐目录（运营下发；缺省时客户端用内置兜底） */
  skillCatalog?: {
    categories: unknown[];
    skills: unknown[];
    bundles: unknown[];
    repositories: unknown[];
  };
  /** MCP 推荐目录（运营下发；缺省时客户端用内置兜底） */
  mcpCatalog?: {
    categories: unknown[];
    servers: unknown[];
  };
  /** 模型路由 override（运营下发；缺省/畸形时客户端降级硬编码 PROVIDER_FALLBACK_CHAIN） */
  modelRouting?: {
    fallbackChain?: Record<string, Array<{ provider: string; model: string }>>;
  };
  /** 团队共享 provider（中转站）；按 subject 的 entitlement 在网关层过滤后下发。 */
  sharedProviders?: SharedProviderConfig[];
  /** 团队共享服务 key（如 Tavily/Brave 搜索），按 subject 的 entitlement 过滤后下发。 */
  sharedServiceKeys?: SharedServiceKeyConfig[];
  entitlement?: {
    status: 'active' | 'trial' | 'expired' | 'revoked';
    plan: string;
    capabilities: string[];
    expiresAt?: string;
    reason?: string;
  };
  subject?: {
    id: string;
    email?: string;
    source: 'server_token_map' | 'supabase_auth';
  };
  killSwitches?: {
    global?: { disabled: boolean; reason?: string };
    features?: Record<string, { disabled: boolean; reason?: string }>;
  };
  release?: {
    channel: 'stable' | 'beta' | 'canary';
    minVersion?: string;
    latestVersion?: string;
    forceUpdate?: boolean;
    updateManifestUrl?: string;
    downloadUrl?: string;
    sha256?: string;
  };
}

export interface PromptRegistryPayload {
  version: string;
  prompts: Record<string, string>;
}

export interface CapabilityRegistryPayload {
  version: string;
  items: unknown[];
  revokedIds?: string[];
  source?: Record<string, unknown>;
}

export interface AgentEngineModelCatalogPayload {
  version: string;
  updatedAt: string;
  engines: Array<{
    kind: 'codex_cli' | 'claude_code';
    defaultModel: string;
    updatedAt?: string;
    models: Array<{
      id: string;
      label: string;
      capabilities: string[];
      recommended?: boolean;
      disabledReason?: string;
      updatedAt?: string;
    }>;
  }>;
}

export interface RendererBundleRolloutPolicyPayload {
  version: string;
  paused?: boolean;
  pauseReason?: string;
  rollbackToBuiltin?: boolean;
  rollbackReason?: string;
  channel?: string;
  manifestUrl?: string;
  manifestContentHash?: string;
  rolloutPercent?: number;
  cohorts?: string[];
  platforms?: string[];
  minShellVersion?: string;
  maxShellVersion?: string;
}

export function readCloudConfigPayload(env: NodeJS.ProcessEnv = process.env): CloudConfigPayload {
  return readJsonPayloadFromEnv<CloudConfigPayload>([
    'CONTROL_PLANE_CLOUD_CONFIG_JSON',
    'CODE_AGENT_CONTROL_PLANE_CLOUD_CONFIG_JSON',
  ], env);
}

export function readCloudConfigPayloadForRequest(
  req: ControlPlaneRequestLike,
  env: NodeJS.ProcessEnv = process.env,
): CloudConfigPayload {
  return applyServerEntitlementGate(req, readCloudConfigPayload(env), env);
}

function firstString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value.find((entry) => typeof entry === 'string' && entry.trim().length > 0)?.trim() ?? null;
  }
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getHeader(req: ControlPlaneRequestLike, name: string): string | null {
  const headers = req.headers ?? {};
  return firstString(headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]);
}

function getBearerToken(req: ControlPlaneRequestLike): string | null {
  const value = getHeader(req, 'authorization');
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function digestSeed(kind: string, value: string): string {
  return `${kind}:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function buildSharedServiceKeySelectionSeed(req: ControlPlaneRequestLike): string {
  const query = req.query ?? {};
  for (const name of ['installId', 'installationId', 'clientId', 'deviceId', 'machineId']) {
    const value = firstString(query[name]);
    if (value) {
      return digestSeed(name, value);
    }
  }

  for (const name of ['x-code-agent-install-id', 'x-code-agent-client-id', 'x-device-id']) {
    const value = getHeader(req, name);
    if (value) {
      return digestSeed(name, value);
    }
  }

  const bearerToken = getBearerToken(req);
  if (bearerToken) {
    return digestSeed('bearer', bearerToken);
  }
  return 'anonymous';
}

export async function readCloudConfigPayloadForRequestAsync(
  req: ControlPlaneRequestLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloudConfigPayload> {
  const base = readCloudConfigPayload(env);
  // 混合方案：已配 Supabase 时，共享配置以 DB 为唯一事实来源（key 仍从 env 取并已注入）；
  // 未配 Supabase 时 fromStore=null → 保留 env-JSON 里的配置（向后兼容）。
  const providersFromStore = await loadSharedProvidersFromStore(env);
  const serviceKeysFromStore = await loadSharedServiceKeysFromStore(env, {
    selectionSeed: buildSharedServiceKeySelectionSeed(req),
  });
  const payload = {
    ...base,
    ...(providersFromStore !== null ? { sharedProviders: providersFromStore } : {}),
    ...(serviceKeysFromStore !== null ? { sharedServiceKeys: serviceKeysFromStore } : {}),
  };
  return applyServerEntitlementGateAsync(req, payload, env);
}

export function readPromptRegistryPayload(env: NodeJS.ProcessEnv = process.env): PromptRegistryPayload {
  return readJsonPayloadFromEnv<PromptRegistryPayload>([
    'CONTROL_PLANE_PROMPT_REGISTRY_JSON',
    'CODE_AGENT_CONTROL_PLANE_PROMPT_REGISTRY_JSON',
  ], env);
}

export function readCapabilityRegistryPayload(env: NodeJS.ProcessEnv = process.env): CapabilityRegistryPayload {
  return readJsonPayloadFromEnv<CapabilityRegistryPayload>([
    'CONTROL_PLANE_CAPABILITY_REGISTRY_JSON',
    'CODE_AGENT_CONTROL_PLANE_CAPABILITY_REGISTRY_JSON',
  ], env);
}

export function readAgentEngineModelCatalogPayload(env: NodeJS.ProcessEnv = process.env): AgentEngineModelCatalogPayload {
  return readJsonPayloadFromEnv<AgentEngineModelCatalogPayload>([
    'CONTROL_PLANE_AGENT_ENGINE_MODEL_CATALOG_JSON',
    'CODE_AGENT_CONTROL_PLANE_AGENT_ENGINE_MODEL_CATALOG_JSON',
  ], env);
}

export function readRendererBundleRolloutPolicyPayload(
  env: NodeJS.ProcessEnv = process.env,
): RendererBundleRolloutPolicyPayload {
  return readJsonPayloadFromEnv<RendererBundleRolloutPolicyPayload>([
    'CONTROL_PLANE_RENDERER_BUNDLE_ROLLOUT_JSON',
    'CODE_AGENT_RENDERER_BUNDLE_ROLLOUT_JSON',
  ], env);
}

export async function readRendererBundleRolloutPolicyPayloadAsync(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RendererBundleRolloutPolicyPayload> {
  const policy = readRendererBundleRolloutPolicyPayload(env);
  return applyRendererBundleAutoRollbackGuard(policy, { env });
}

export function readPayloadForKind(
  kind: ControlPlaneArtifactKind,
  req?: ControlPlaneRequestLike,
  env: NodeJS.ProcessEnv = process.env,
): CloudConfigPayload | CapabilityRegistryPayload | AgentEngineModelCatalogPayload | PromptRegistryPayload | RendererBundleRolloutPolicyPayload {
  if (kind === 'cloud_config') {
    return req ? readCloudConfigPayloadForRequest(req, env) : readCloudConfigPayload(env);
  }
  if (kind === 'capability_registry') {
    return readCapabilityRegistryPayload(env);
  }
  if (kind === 'agent_engine_model_catalog') {
    return readAgentEngineModelCatalogPayload(env);
  }
  if (kind === 'prompt_registry') {
    return readPromptRegistryPayload(env);
  }
  if (kind === 'renderer_bundle_rollout') {
    return readRendererBundleRolloutPolicyPayload(env);
  }
  throw new Error(`Unsupported control-plane artifact: ${kind}`);
}

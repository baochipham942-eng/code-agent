import type { ControlPlaneArtifactKind } from './controlPlaneEnvelope.js';
import type { ControlPlaneRequestLike } from './controlPlaneEnvelope.js';
import { applyServerEntitlementGate, applyServerEntitlementGateAsync } from './controlPlaneEntitlements.js';
import { readJsonPayloadFromEnv } from './controlPlaneEnvelope.js';

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

export function readCloudConfigPayloadForRequestAsync(
  req: ControlPlaneRequestLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloudConfigPayload> {
  return applyServerEntitlementGateAsync(req, readCloudConfigPayload(env), env);
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

export function readPayloadForKind(
  kind: ControlPlaneArtifactKind,
  req?: ControlPlaneRequestLike,
  env: NodeJS.ProcessEnv = process.env,
): CloudConfigPayload | CapabilityRegistryPayload | AgentEngineModelCatalogPayload | PromptRegistryPayload {
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
  throw new Error(`Unsupported control-plane artifact: ${kind}`);
}

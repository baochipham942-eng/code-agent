import type { ControlPlaneArtifactKind } from './controlPlaneEnvelope';
import { readJsonPayloadFromEnv } from './controlPlaneEnvelope';

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

export function readCloudConfigPayload(env: NodeJS.ProcessEnv = process.env): CloudConfigPayload {
  return readJsonPayloadFromEnv<CloudConfigPayload>([
    'CONTROL_PLANE_CLOUD_CONFIG_JSON',
    'CODE_AGENT_CONTROL_PLANE_CLOUD_CONFIG_JSON',
  ], env);
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

export function readPayloadForKind(
  kind: ControlPlaneArtifactKind,
  env: NodeJS.ProcessEnv = process.env,
): CloudConfigPayload | CapabilityRegistryPayload | PromptRegistryPayload {
  if (kind === 'cloud_config') {
    return readCloudConfigPayload(env);
  }
  if (kind === 'capability_registry') {
    return readCapabilityRegistryPayload(env);
  }
  if (kind === 'prompt_registry') {
    return readPromptRegistryPayload(env);
  }
  throw new Error(`Unsupported control-plane artifact: ${kind}`);
}

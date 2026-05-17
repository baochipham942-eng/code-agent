// ============================================================================
// Prompt Service - 云端 System Prompt 管理
// ============================================================================
// 优先从云端拉取 prompts，本地缓存 + 降级到内置 prompts

import { SYSTEM_PROMPT } from '../../prompts/builder';
import { createLogger } from '../infra/logger';
import { CACHE, CLOUD, CLOUD_ENDPOINTS } from '../../../shared/constants';
import {
  getControlPlanePublicKeysFromEnv,
  isControlPlaneEnvelope,
  verifyControlPlaneEnvelope,
  type ControlPlanePublicKeys,
} from './controlPlaneTrust';
import type { ControlPlaneDiagnostic } from '../../../shared/contract/controlPlane';

const logger = createLogger('PromptService');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface CloudPromptsResponse {
  version: string;
  prompts: Record<string, string>;
}

interface CachedPrompts {
  version: string;
  prompts: Record<string, string>;
  fetchedAt: number;
}

export interface PromptServiceOptions {
  getAccessToken?: () => Promise<string | null>;
  controlPlanePublicKeys?: ControlPlanePublicKeys;
  allowUnsignedPrompts?: boolean;
}

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------

let cachedPrompts: CachedPrompts | null = null;
let fetchPromise: Promise<void> | null = null;
let promptOptions: PromptServiceOptions = {};
let trustDiagnostics: ControlPlaneDiagnostic[] = [];
let trustInfo: { trusted: boolean; keyId?: string; expiresAt?: string } = { trusted: false };

export function configurePromptService(options: PromptServiceOptions): void {
  promptOptions = {
    ...promptOptions,
    ...options,
  };
}

function getPublicKeys(): ControlPlanePublicKeys {
  return promptOptions.controlPlanePublicKeys || getControlPlanePublicKeysFromEnv();
}

function allowUnsignedPrompts(): boolean {
  return promptOptions.allowUnsignedPrompts === true
    || process.env.CODE_AGENT_ALLOW_UNSIGNED_PROMPTS === '1';
}

function acceptFetchedPrompts(value: unknown): CloudPromptsResponse | null {
  if (isControlPlaneEnvelope(value)) {
    const trust = verifyControlPlaneEnvelope<CloudPromptsResponse>(value, {
      kind: 'prompt_registry',
      publicKeys: getPublicKeys(),
      requireSignature: !allowUnsignedPrompts(),
      allowUnsigned: allowUnsignedPrompts(),
    });
    trustDiagnostics = trust.diagnostics;
    trustInfo = {
      trusted: trust.trusted,
      ...(trust.keyId ? { keyId: trust.keyId } : {}),
      ...(trust.expiresAt ? { expiresAt: trust.expiresAt } : {}),
    };
    if (!trust.trusted || !trust.payload) {
      logger.warn('Rejected untrusted cloud prompts', {
        diagnostics: trust.diagnostics.map((entry) => entry.code).join(', '),
      });
      return null;
    }
    return trust.payload;
  }

  if (allowUnsignedPrompts()) {
    trustDiagnostics = [{
      severity: 'warning',
      code: 'unsigned_prompts_allowed',
      message: 'Unsigned prompt registry was accepted because CODE_AGENT_ALLOW_UNSIGNED_PROMPTS is enabled.',
    }];
    trustInfo = { trusted: false };
    logger.warn('Accepting unsigned cloud prompts because unsigned override is enabled');
    return value as CloudPromptsResponse;
  }

  trustDiagnostics = [{
    severity: 'error',
    code: 'missing_control_plane_envelope',
    message: 'Cloud prompt responses must be signed control-plane envelopes.',
  }];
  trustInfo = { trusted: false };
  logger.warn('Rejected unsigned cloud prompts response');
  return null;
}

// ----------------------------------------------------------------------------
// Core Functions
// ----------------------------------------------------------------------------

/**
 * 从云端拉取 prompts
 */
async function fetchCloudPrompts(): Promise<CloudPromptsResponse | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLOUD.FETCH_TIMEOUT);

    const headers: Record<string, string> = {};
    const accessToken = await promptOptions.getAccessToken?.().catch((error) => {
      logger.warn('Failed to read prompt registry access token', { error: String(error) });
      return null;
    });
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    const response = await fetch(`${CLOUD_ENDPOINTS.prompts}?gen=all`, {
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.warn('Cloud API error', { status: response.status });
      return null;
    }

    const data = acceptFetchedPrompts(await response.json());
    if (!data?.version || !data.prompts) {
      return null;
    }
    logger.info('Fetched trusted cloud prompts', {
      version: data.version,
      expiresAt: trustInfo.expiresAt || 'not set',
      keyId: trustInfo.keyId || 'not set',
    });
    return data;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      logger.warn('Cloud fetch timeout');
    } else {
      logger.warn('Cloud fetch failed', { error });
    }
    return null;
  }
}

/**
 * 初始化 prompt 服务（后台异步拉取）
 */
export async function initPromptService(options?: PromptServiceOptions): Promise<void> {
  if (options) {
    configurePromptService(options);
  }
  // 避免重复拉取
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    const cloudData = await fetchCloudPrompts();
    if (cloudData) {
      cachedPrompts = {
        version: cloudData.version,
        prompts: cloudData.prompts,
        fetchedAt: Date.now(),
      };
      logger.info('Cached cloud prompts');
    } else {
      logger.info('Using built-in prompts');
    }
  })();

  return fetchPromise;
}

/**
 * 获取指定代际的 system prompt
 * 优先返回云端版本，降级到本地内置版本
 */
export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

/**
 * 强制刷新 prompts
 */
export async function refreshPrompts(): Promise<boolean> {
  fetchPromise = null;
  cachedPrompts = null;
  await initPromptService();
  return cachedPrompts !== null;
}

/**
 * 获取当前 prompts 来源信息
 */
export function getPromptsInfo(): {
  source: 'cloud' | 'builtin';
  version: string | null;
  fetchedAt: number | null;
  trust: {
    trusted: boolean;
    keyId?: string;
    expiresAt?: string;
    diagnostics: ControlPlaneDiagnostic[];
  };
} {
  if (cachedPrompts) {
    return {
      source: 'cloud',
      version: cachedPrompts.version,
      fetchedAt: cachedPrompts.fetchedAt,
      trust: {
        trusted: trustInfo.trusted,
        ...(trustInfo.keyId ? { keyId: trustInfo.keyId } : {}),
        ...(trustInfo.expiresAt ? { expiresAt: trustInfo.expiresAt } : {}),
        diagnostics: trustDiagnostics,
      },
    };
  }
  return {
    source: 'builtin',
    version: null,
    fetchedAt: null,
    trust: {
      trusted: trustInfo.trusted,
      ...(trustInfo.keyId ? { keyId: trustInfo.keyId } : {}),
      ...(trustInfo.expiresAt ? { expiresAt: trustInfo.expiresAt } : {}),
      diagnostics: trustDiagnostics,
    },
  };
}

import { createLogger } from '../services/infra/logger';
import {
  ARTIFACT_FIRST_BYTE_TIMEOUT_MS,
  ARTIFACT_INACTIVITY_TIMEOUT_MS,
  ARTIFACT_PROVIDER_TIMEOUT_MS,
  ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS,
  ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS,
  ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS,
  ARTIFACT_REPAIR_TARGETED_WRITE_FIRST_BYTE_TIMEOUT_MS,
  ARTIFACT_REPAIR_TARGETED_WRITE_INACTIVITY_TIMEOUT_MS,
  ARTIFACT_REPAIR_TARGETED_WRITE_TIMEOUT_MS,
  ARTIFACT_REPAIR_WRITE_FIRST_BYTE_TIMEOUT_MS,
  ARTIFACT_REPAIR_WRITE_INACTIVITY_TIMEOUT_MS,
  ARTIFACT_REPAIR_WRITE_TIMEOUT_MS,
} from './modelRouterTimeouts';
import {
  hasArtifactRepairToolBlockedMarker,
  hasArtifactValidationFailureMarker,
  hasExplicitArtifactRepairIntent,
  isArtifactLikeRequest,
  shouldPreferNonStreamingArtifactFileTurn,
  shouldPreferNonStreamingArtifactTurn,
} from './modelRouterPolicy';
import type { InferenceOptions, ModelMessage, StreamCallback } from './types';

const logger = createLogger('ModelRouter');

export function normalizeInferenceOptions(
  messages: ModelMessage[],
  onStream?: StreamCallback,
  options?: InferenceOptions,
): InferenceOptions | undefined {
  if (options?.artifactRepairActive === true && options?.forceNonStreaming !== true) {
    const writePriority = options?.artifactRepairWritePriority === true;
    const fullRewritePriority = options?.artifactRepairFullRewritePriority === true;
    logger.info(fullRewritePriority
      ? '[ModelRouter] Runtime artifact repair full-rewrite guard active; preferring non-streaming inference with artifact timeout'
      : writePriority
        ? '[ModelRouter] Runtime artifact repair write-priority guard active; preferring non-streaming inference with targeted write timeout'
        : '[ModelRouter] Runtime artifact repair guard active; preferring non-streaming inference with shorter timeout');
    return {
      ...options,
      forceNonStreaming: true,
      disableProviderTransientRetry: true,
      // Artifact generation/repair = long content, short reasoning. Default
      // thinking-mode models to 'low' reasoning_effort so they don't burn
      // the output budget on internal deliberation.
      reasoningEffort: options?.reasoningEffort ?? 'low',
      requestTimeoutMs: options?.requestTimeoutMs ?? (
        fullRewritePriority
          ? ARTIFACT_REPAIR_WRITE_TIMEOUT_MS
          : writePriority
            ? ARTIFACT_REPAIR_TARGETED_WRITE_TIMEOUT_MS
            : ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS
      ),
      firstByteTimeoutMs: options?.firstByteTimeoutMs ?? (
        fullRewritePriority
          ? ARTIFACT_REPAIR_WRITE_FIRST_BYTE_TIMEOUT_MS
          : writePriority
            ? ARTIFACT_REPAIR_TARGETED_WRITE_FIRST_BYTE_TIMEOUT_MS
            : ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS
      ),
      inactivityTimeoutMs: options?.inactivityTimeoutMs ?? (
        fullRewritePriority
          ? ARTIFACT_REPAIR_WRITE_INACTIVITY_TIMEOUT_MS
          : writePriority
            ? ARTIFACT_REPAIR_TARGETED_WRITE_INACTIVITY_TIMEOUT_MS
            : ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS
      ),
    };
  }

  if (hasArtifactRepairToolBlockedMarker(messages)) {
    logger.info('[ModelRouter] Artifact repair blocked-tool recovery detected; using shorter streaming timeout');
    return {
      ...options,
      disableProviderTransientRetry: true,
      reasoningEffort: options?.reasoningEffort ?? 'low',
      requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS,
      firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS,
      inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS,
    };
  }

  if (hasArtifactValidationFailureMarker(messages)) {
    logger.info('[ModelRouter] Artifact validation repair turn detected; preferring non-streaming inference with shorter timeout');
    return {
      ...options,
      forceNonStreaming: true,
      disableProviderTransientRetry: true,
      reasoningEffort: options?.reasoningEffort ?? 'low',
      requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS,
      firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS,
      inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS,
    };
  }

  if (hasExplicitArtifactRepairIntent(messages)) {
    logger.info('[ModelRouter] Explicit artifact repair turn detected; preferring non-streaming inference with shorter timeout');
    return {
      ...options,
      forceNonStreaming: true,
      disableProviderTransientRetry: true,
      reasoningEffort: options?.reasoningEffort ?? 'low',
      requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS,
      firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS,
      inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS,
    };
  }

  if (shouldPreferNonStreamingArtifactFileTurn(messages, onStream, options)) {
    // v2 streaming-first: 保持 SSE chunk 不断流，避开上游网关对长 non-streaming 响应的 ~168s 硬超时（实测 Xiaomi sgp）。
    // tool-arg 解析失败时由 _callProviderWithArtifactFallback 接住，自动退到 forceNonStreaming 重试一次。
    logger.info('[ModelRouter] Artifact file-generation turn detected; v2 streaming-first (non-streaming fallback on tool-arg parse error)');
    return {
      ...options,
      disableProviderTransientRetry: true,
      reasoningEffort: options?.reasoningEffort ?? 'low',
      requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_PROVIDER_TIMEOUT_MS,
      firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_FIRST_BYTE_TIMEOUT_MS,
      inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_INACTIVITY_TIMEOUT_MS,
    };
  }

  const shouldDisableProviderRetry =
    Boolean(onStream) &&
    options?.forceNonStreaming !== true &&
    isArtifactLikeRequest(messages);

  if (!shouldPreferNonStreamingArtifactTurn(messages, onStream, options)) {
    return shouldDisableProviderRetry
      ? {
          ...options,
          disableProviderTransientRetry: true,
          reasoningEffort: options?.reasoningEffort ?? 'low',
          requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_PROVIDER_TIMEOUT_MS,
          firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_FIRST_BYTE_TIMEOUT_MS,
          inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_INACTIVITY_TIMEOUT_MS,
        }
      : options;
  }

  // v2 streaming-first（同 file-generation turn）：保持 SSE 流不断，避开网关 ~168s 硬超时。
  logger.info('[ModelRouter] Artifact follow-up turn detected; v2 streaming-first (non-streaming fallback on tool-arg parse error)');
  return {
    ...options,
    disableProviderTransientRetry: true,
    reasoningEffort: options?.reasoningEffort ?? 'low',
    requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_PROVIDER_TIMEOUT_MS,
    firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_FIRST_BYTE_TIMEOUT_MS,
    inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_INACTIVITY_TIMEOUT_MS,
  };
}

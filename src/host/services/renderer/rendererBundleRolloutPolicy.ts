// ============================================================================
// 前端热更：灰度策略选择（signed renderer_bundle_rollout payload）
// ============================================================================

import * as crypto from 'node:crypto';
import { compareUpdateVersions } from '../cloud/updateService';
import {
  RENDERER_BUNDLE_CHANNEL_ENV,
  RENDERER_BUNDLE_MANIFEST_URL_ENV,
  RendererBundleEndpointError,
  resolveRendererBundleEndpoint,
  type RendererBundleEndpointResolution,
} from '../../../shared/constants/network';

export interface RendererBundleRolloutPolicy {
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

export interface RendererBundleRolloutContext {
  currentShellVersion: string;
  fallbackEndpoint: RendererBundleEndpointResolution;
  rolloutSeed: string;
  cohort?: string;
  platform?: string;
}

export type RendererBundleRolloutDecision =
  | {
      action: 'use-manifest';
      manifestUrl: string;
      channel: string;
      manifestUrlOverride?: boolean;
      policyVersion: string;
      rolloutApplied: boolean;
      rolloutBucket?: number;
      rolloutPercent?: number;
      fallbackReason?: string;
    }
  | {
      action: 'skip';
      reason: 'invalid-rollout-policy' | 'rollout-paused';
      policyVersion?: string;
      pauseReason?: string;
      errorMessage?: string;
    }
  | {
      action: 'rollback-to-builtin';
      reason: 'rollout-rollback-to-builtin';
      policyVersion: string;
      rollbackReason?: string;
    };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function isValidPolicy(value: unknown): value is RendererBundleRolloutPolicy {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Record<string, unknown>;
  return (
    typeof policy.version === 'string' && policy.version.trim().length > 0 &&
    (policy.paused === undefined || typeof policy.paused === 'boolean') &&
    (policy.pauseReason === undefined || typeof policy.pauseReason === 'string') &&
    (policy.rollbackToBuiltin === undefined || typeof policy.rollbackToBuiltin === 'boolean') &&
    (policy.rollbackReason === undefined || typeof policy.rollbackReason === 'string') &&
    (policy.channel === undefined || typeof policy.channel === 'string') &&
    (policy.manifestUrl === undefined || typeof policy.manifestUrl === 'string') &&
    (policy.manifestContentHash === undefined || typeof policy.manifestContentHash === 'string') &&
    (policy.rolloutPercent === undefined || typeof policy.rolloutPercent === 'number') &&
    (policy.cohorts === undefined || isStringArray(policy.cohorts)) &&
    (policy.platforms === undefined || isStringArray(policy.platforms)) &&
    (policy.minShellVersion === undefined || typeof policy.minShellVersion === 'string') &&
    (policy.maxShellVersion === undefined || typeof policy.maxShellVersion === 'string')
  );
}

export function rendererBundleRolloutBucket(seed: string, policyVersion: string): number {
  const digest = crypto.createHash('sha256').update(`${policyVersion}:${seed}`).digest();
  const raw = digest.readUInt32BE(0);
  return Math.floor((raw / 0x100000000) * 10000) / 100;
}

function fallbackDecision(
  policy: RendererBundleRolloutPolicy,
  ctx: RendererBundleRolloutContext,
  fallbackReason?: string,
  rolloutBucket?: number,
): RendererBundleRolloutDecision {
  return {
    action: 'use-manifest',
    manifestUrl: ctx.fallbackEndpoint.manifestUrl,
    channel: ctx.fallbackEndpoint.channel,
    ...(ctx.fallbackEndpoint.manifestUrlOverride ? { manifestUrlOverride: true } : {}),
    policyVersion: policy.version,
    rolloutApplied: false,
    ...(rolloutBucket !== undefined ? { rolloutBucket } : {}),
    ...(policy.rolloutPercent !== undefined ? { rolloutPercent: policy.rolloutPercent } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function resolveTargetEndpoint(
  policy: RendererBundleRolloutPolicy,
  fallbackEndpoint: RendererBundleEndpointResolution,
): RendererBundleEndpointResolution {
  const manifestUrl = policy.manifestUrl?.trim();
  if (manifestUrl) {
    return resolveRendererBundleEndpoint({
      [RENDERER_BUNDLE_CHANNEL_ENV]: policy.channel?.trim() || fallbackEndpoint.channel,
      [RENDERER_BUNDLE_MANIFEST_URL_ENV]: manifestUrl,
    });
  }

  const channel = policy.channel?.trim();
  if (channel) {
    return resolveRendererBundleEndpoint({
      [RENDERER_BUNDLE_CHANNEL_ENV]: channel,
    });
  }

  return fallbackEndpoint;
}

export function decideRendererBundleRollout(
  policy: unknown,
  ctx: RendererBundleRolloutContext,
): RendererBundleRolloutDecision {
  if (!isValidPolicy(policy)) {
    return { action: 'skip', reason: 'invalid-rollout-policy' };
  }

  const normalized: RendererBundleRolloutPolicy = {
    ...policy,
    version: policy.version.trim(),
    ...(policy.channel ? { channel: policy.channel.trim() } : {}),
    ...(policy.manifestUrl ? { manifestUrl: policy.manifestUrl.trim() } : {}),
  };

  if (normalized.paused) {
    return {
      action: 'skip',
      reason: 'rollout-paused',
      policyVersion: normalized.version,
      ...(normalized.pauseReason ? { pauseReason: normalized.pauseReason } : {}),
    };
  }

  if (normalized.rollbackToBuiltin) {
    return {
      action: 'rollback-to-builtin',
      reason: 'rollout-rollback-to-builtin',
      policyVersion: normalized.version,
      ...(normalized.rollbackReason ? { rollbackReason: normalized.rollbackReason } : {}),
    };
  }

  if (
    normalized.minShellVersion &&
    compareUpdateVersions(ctx.currentShellVersion, normalized.minShellVersion) < 0
  ) {
    return fallbackDecision(normalized, ctx, 'rollout-shell-too-old');
  }

  if (
    normalized.maxShellVersion &&
    compareUpdateVersions(ctx.currentShellVersion, normalized.maxShellVersion) > 0
  ) {
    return fallbackDecision(normalized, ctx, 'rollout-shell-too-new');
  }

  if (
    normalized.platforms &&
    normalized.platforms.length > 0 &&
    (!ctx.platform || !normalized.platforms.includes(ctx.platform))
  ) {
    return fallbackDecision(normalized, ctx, 'rollout-platform-mismatch');
  }

  if (
    normalized.cohorts &&
    normalized.cohorts.length > 0 &&
    (!ctx.cohort || !normalized.cohorts.includes(ctx.cohort))
  ) {
    return fallbackDecision(normalized, ctx, 'rollout-cohort-mismatch');
  }

  let rolloutBucket: number | undefined;
  if (normalized.rolloutPercent !== undefined) {
    if (
      !Number.isFinite(normalized.rolloutPercent) ||
      normalized.rolloutPercent < 0 ||
      normalized.rolloutPercent > 100
    ) {
      return {
        action: 'skip',
        reason: 'invalid-rollout-policy',
        policyVersion: normalized.version,
        errorMessage: 'rolloutPercent must be a number between 0 and 100',
      };
    }
    rolloutBucket = rendererBundleRolloutBucket(ctx.rolloutSeed, normalized.version);
    if (rolloutBucket >= normalized.rolloutPercent) {
      return fallbackDecision(normalized, ctx, 'rollout-percent-excluded', rolloutBucket);
    }
  }

  try {
    const target = resolveTargetEndpoint(normalized, ctx.fallbackEndpoint);
    return {
      action: 'use-manifest',
      manifestUrl: target.manifestUrl,
      channel: target.channel,
      ...(target.manifestUrlOverride ? { manifestUrlOverride: true } : {}),
      policyVersion: normalized.version,
      rolloutApplied: Boolean(normalized.channel || normalized.manifestUrl),
      ...(rolloutBucket !== undefined ? { rolloutBucket } : {}),
      ...(normalized.rolloutPercent !== undefined ? { rolloutPercent: normalized.rolloutPercent } : {}),
    };
  } catch (err) {
    if (err instanceof RendererBundleEndpointError) {
      return {
        action: 'skip',
        reason: 'invalid-rollout-policy',
        policyVersion: normalized.version,
        errorMessage: err.message,
      };
    }
    return {
      action: 'skip',
      reason: 'invalid-rollout-policy',
      policyVersion: normalized.version,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// UpdateSettings.helpers - 渲染层热更新诊断行纯函数
// 从 UpdateSettings.tsx 纯平移拆出（god-file 债务门 1009/1000）。
// ============================================================================

import type { RendererBundleStatus } from '@shared/contract';
import { zh } from '../../../../i18n/zh';

type UpdateSettingsText = typeof zh.settings.update;
const DEFAULT_UPDATE_SETTINGS_TEXT = zh.settings.update;

export function shortContentHash(contentHash: string | undefined): string {
  return contentHash ? contentHash.slice(0, 12) : 'unknown';
}

export function getRendererBundleDiagnosticRows(
  status: RendererBundleStatus | null,
  text: UpdateSettingsText['rendererBundle'] = DEFAULT_UPDATE_SETTINGS_TEXT.rendererBundle,
): Array<{ label: string; value: string }> {
  if (!status) return [];
  const labels = text.diagnosticLabels;
  const rows: Array<{ label: string; value: string }> = [];
  rows.push({
    label: labels.current,
    value: status.activeBundle
      ? `v${status.activeBundle.version} · ${shortContentHash(status.activeBundle.contentHash)}`
      : labels.builtinVersion,
  });
  if (status.disabledReason) {
    rows.push({ label: labels.disabledReason, value: status.disabledReason });
  }
  if (status.source) {
    rows.push({
      label: labels.sourceEntry,
      value: [
        status.source.manifestUrlOverride ? 'manifest override' : 'channel',
        status.source.channel,
      ].filter(Boolean).join(' · '),
    });
    if (status.source.errorReason) {
      rows.push({
        label: labels.sourceError,
        value: [
          status.source.errorReason,
          status.source.errorTarget,
        ].filter(Boolean).join(' · '),
      });
    } else if (status.source.manifestUrl) {
      rows.push({ label: labels.manifestConfig, value: status.source.manifestUrl });
    }
    if (status.source.rolloutPolicyUrl) {
      rows.push({ label: labels.policyEntry, value: status.source.rolloutPolicyUrl });
    }
    if (status.source.cohort) {
      rows.push({ label: labels.cohort, value: status.source.cohort });
    }
  }
  const attempt = status.lastAttempt;
  if (!attempt) return rows;
  rows.push({
    label: labels.recentCheck,
    value: [
      attempt.outcome,
      attempt.reason,
      attempt.checkedAt,
    ].filter(Boolean).join(' · '),
  });
  if (attempt.manifest) {
    rows.push({
      label: labels.candidateVersion,
      value: [
        `v${attempt.manifest.version}`,
        `min shell v${attempt.manifest.minShellVersion}`,
        `${attempt.manifest.requiredShellCapabilitiesCount} capabilities`,
        attempt.manifest.requiredRuntimeAssetsCount
          ? `${attempt.manifest.requiredRuntimeAssetsCount} runtime assets`
          : null,
        attempt.manifest.requiredResourcesCount
          ? `${attempt.manifest.requiredResourcesCount} resources`
          : null,
        attempt.manifest.rollbackToBuiltin ? 'rollback' : null,
      ].filter(Boolean).join(' · '),
    });
    if (attempt.manifest.contentHash) {
      rows.push({
        label: labels.candidateHash,
        value: shortContentHash(attempt.manifest.contentHash),
      });
    }
  }
  if (attempt.manifestUrl) {
    rows.push({ label: labels.manifest, value: attempt.manifestUrl });
  }
  if (attempt.rollout) {
    rows.push({
      label: labels.policyDecision,
      value: [
        attempt.rollout.decision,
        attempt.rollout.policyVersion,
        attempt.rollout.rolloutApplied === true ? 'target' : null,
        attempt.rollout.rolloutApplied === false ? 'fallback' : null,
        attempt.rollout.fallbackReason,
        attempt.rollout.reason,
      ].filter(Boolean).join(' · '),
    });
  }
  if (attempt.runtimeAssetPreparation) {
    rows.push({
      label: labels.runtimePrepare,
      value: [
        `${attempt.runtimeAssetPreparation.installed.length} installed`,
        `${attempt.runtimeAssetPreparation.skipped.length} skipped`,
        attempt.runtimeAssetPreparation.errorMessage,
      ].filter(Boolean).join(' · '),
    });
  }
  return rows;
}


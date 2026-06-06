#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractRendererManifestPayload } from './renderer-manifest-diff.mjs';
import { shellCapabilityLayerForId } from '../src/shared/contract/shellCapabilities.ts';

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function sortedStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeRolloutPercent(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error('buildRendererReleaseRecord: rolloutPercent must be a number between 0 and 100');
  }
  return percent;
}

function countShellCapabilitiesByLayer(requiredShellCapabilities) {
  return requiredShellCapabilities.reduce((counts, capabilityId) => {
    const layer = shellCapabilityLayerForId(capabilityId);
    counts[layer] = (counts[layer] || 0) + 1;
    return counts;
  }, { domain: 0, native: 0 });
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function buildRendererReleaseRecord({
  manifest,
  manifestDiff = null,
  createdAt = new Date().toISOString(),
  channel = 'latest',
  cohort,
  rolloutPercent,
  bundleBaseUrl,
  snapshotBaseUrl,
  git = {},
}) {
  if (!manifest?.version) {
    throw new Error('buildRendererReleaseRecord: manifest.version is required');
  }
  const requiredShellCapabilities = sortedStringArray(manifest.requiredShellCapabilities);
  const requiredRuntimeAssets = sortedStringArray(manifest.requiredRuntimeAssets);
  const requiredResources = sortedStringArray(manifest.requiredResources);
  const requiredShellCapabilitiesByLayer = countShellCapabilitiesByLayer(requiredShellCapabilities);
  const normalizedCohort = normalizeOptionalString(cohort);
  const normalizedRolloutPercent = normalizeRolloutPercent(rolloutPercent);
  return {
    schemaVersion: 1,
    kind: 'renderer_bundle_release_record',
    createdAt,
    channel,
    rollout: {
      channel,
      ...(normalizedCohort ? { cohort: normalizedCohort } : {}),
      ...(normalizedRolloutPercent !== undefined ? { percent: normalizedRolloutPercent } : {}),
    },
    version: manifest.version,
    minShellVersion: manifest.minShellVersion,
    rollbackToBuiltin: manifest.rollbackToBuiltin === true,
    ...(manifest.rollbackReason ? { rollbackReason: manifest.rollbackReason } : {}),
    ...(manifest.contentHash ? { contentHash: manifest.contentHash } : {}),
    ...(manifest.bundleUrl ? { bundleUrl: manifest.bundleUrl } : {}),
    requiredShellCapabilitiesCount: requiredShellCapabilities.length,
    requiredShellCapabilitiesByLayer,
    requiredShellCapabilities,
    requiredRuntimeAssetsCount: requiredRuntimeAssets.length,
    requiredRuntimeAssets,
    requiredResourcesCount: requiredResources.length,
    requiredResources,
    urls: {
      ...(bundleBaseUrl ? {
        latestManifest: `${bundleBaseUrl.replace(/\/$/, '')}/manifest.json`,
        latestBundle: manifest.rollbackToBuiltin ? null : `${bundleBaseUrl.replace(/\/$/, '')}/bundle.tar.gz`,
        latestReleaseRecord: `${bundleBaseUrl.replace(/\/$/, '')}/release-record.json`,
      } : {}),
      ...(snapshotBaseUrl ? {
        snapshotManifest: `${snapshotBaseUrl.replace(/\/$/, '')}/manifest.json`,
        snapshotBundle: manifest.rollbackToBuiltin ? null : `${snapshotBaseUrl.replace(/\/$/, '')}/bundle.tar.gz`,
        snapshotReleaseRecord: `${snapshotBaseUrl.replace(/\/$/, '')}/release-record.json`,
      } : {}),
    },
    git: {
      repository: git.repository ?? '',
      ref: git.ref ?? '',
      sha: git.sha ?? '',
      actor: git.actor ?? '',
      workflow: git.workflow ?? '',
      runId: git.runId ?? '',
      runAttempt: git.runAttempt ?? '',
    },
    ...(manifestDiff ? { manifestDiff } : {}),
  };
}

function formatValue(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === null || value === undefined || value === '') return '(empty)';
  return String(value);
}

function formatList(values, maxRows = 40) {
  if (!values || values.length === 0) return '_None._';
  const visible = values.slice(0, maxRows);
  const rows = visible.map((entry) => `- \`${entry}\``);
  if (values.length > visible.length) {
    rows.push(`- _Showing ${visible.length} of ${values.length}._`);
  }
  return rows.join('\n');
}

function formatFieldChanges(changes) {
  if (!changes || changes.length === 0) return '_None._';
  return [
    '| Field | Current latest | Candidate |',
    '|---|---|---|',
    ...changes.map((change) => `| ${change.field} | \`${formatValue(change.base)}\` | \`${formatValue(change.head)}\` |`),
  ].join('\n');
}

export function formatRendererReleaseRecordMarkdown(record) {
  return [
    '# Renderer Bundle Release Record',
    '',
    `Version: ${record.version}`,
    `Channel: ${record.channel}`,
    `Cohort: ${record.rollout?.cohort || '(empty)'}`,
    `Rollout percent: ${record.rollout?.percent ?? '(empty)'}`,
    `Created at: ${record.createdAt}`,
    `Min shell version: ${record.minShellVersion || '(empty)'}`,
    `Rollback to builtin: ${record.rollbackToBuiltin}`,
    `Required shell capabilities: ${record.requiredShellCapabilitiesCount} (domain=${record.requiredShellCapabilitiesByLayer?.domain ?? 0}, native=${record.requiredShellCapabilitiesByLayer?.native ?? 0})`,
    `Required runtime assets: ${record.requiredRuntimeAssetsCount ?? 0}`,
    `Required resources: ${record.requiredResourcesCount ?? 0}`,
    '',
    '## Git',
    '',
    `Repository: ${record.git.repository || '(empty)'}`,
    `Ref: ${record.git.ref || '(empty)'}`,
    `SHA: ${record.git.sha || '(empty)'}`,
    `Run: ${record.git.runId || '(empty)'} / attempt ${record.git.runAttempt || '(empty)'}`,
    '',
    '## Manifest Changes',
    '',
    formatFieldChanges(record.manifestDiff?.fieldChanges),
    '',
    '## Added Required Shell Capabilities',
    '',
    formatList(record.manifestDiff?.addedRequiredShellCapabilities ?? record.requiredShellCapabilities),
    '',
    '## Removed Required Shell Capabilities',
    '',
    formatList(record.manifestDiff?.removedRequiredShellCapabilities ?? []),
    '',
    '## Added Required Runtime Assets',
    '',
    formatList(record.manifestDiff?.addedRequiredRuntimeAssets ?? record.requiredRuntimeAssets ?? []),
    '',
    '## Removed Required Runtime Assets',
    '',
    formatList(record.manifestDiff?.removedRequiredRuntimeAssets ?? []),
    '',
    '## Added Required Resources',
    '',
    formatList(record.manifestDiff?.addedRequiredResources ?? record.requiredResources ?? []),
    '',
    '## Removed Required Resources',
    '',
    formatList(record.manifestDiff?.removedRequiredResources ?? []),
    '',
  ].join('\n');
}

function main() {
  const manifestPath = readArg('--manifest-path');
  if (!manifestPath) {
    throw new Error('renderer-release-record requires --manifest-path');
  }
  const manifest = extractRendererManifestPayload(readJsonFile(path.resolve(manifestPath)));
  const manifestDiffPath = readArg('--manifest-diff-json');
  const manifestDiff = manifestDiffPath ? readJsonFile(path.resolve(manifestDiffPath)) : null;
  const record = buildRendererReleaseRecord({
    manifest,
    manifestDiff,
    createdAt: readArg('--created-at') || process.env.RENDERER_RELEASE_CREATED_AT || new Date().toISOString(),
    channel: readArg('--channel') || process.env.RENDERER_RELEASE_CHANNEL || 'latest',
    cohort: readArg('--cohort') || process.env.RENDERER_RELEASE_COHORT,
    rolloutPercent: readArg('--rollout-percent') || process.env.RENDERER_RELEASE_PERCENT,
    bundleBaseUrl: readArg('--bundle-base-url') || process.env.BUNDLE_BASE_URL,
    snapshotBaseUrl: readArg('--snapshot-base-url') || process.env.SNAPSHOT_BASE_URL,
    git: {
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
      actor: process.env.GITHUB_ACTOR,
      workflow: process.env.GITHUB_WORKFLOW,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    },
  });
  const markdown = formatRendererReleaseRecordMarkdown(record);
  const outputJson = readArg('--output-json') || 'dist/renderer-bundle/release-record.json';
  const outputMarkdown = readArg('--output-markdown') || 'dist/renderer-bundle/release-record.md';
  fs.mkdirSync(path.dirname(outputJson), { recursive: true });
  fs.mkdirSync(path.dirname(outputMarkdown), { recursive: true });
  fs.writeFileSync(outputJson, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.writeFileSync(outputMarkdown, `${markdown}\n`, 'utf8');
  process.stdout.write(`${markdown}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

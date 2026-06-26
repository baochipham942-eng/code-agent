#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  getControlPlanePublicKeysFromEnv,
  verifyControlPlaneEnvelope,
} from '../src/host/services/cloud/controlPlaneTrust.ts';

const DIFF_FIELDS = [
  'version',
  'minShellVersion',
  'contentHash',
  'bundleUrl',
  'rollbackToBuiltin',
  'rollbackReason',
];

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isControlPlaneEnvelopeLike(value) {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.kind === 'renderer_bundle'
    && Object.prototype.hasOwnProperty.call(value, 'payload');
}

function sortedStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeRendererManifestPayload(payload) {
  const manifest = isRecord(payload) ? payload : {};
  return {
    version: typeof manifest.version === 'string' ? manifest.version : '',
    minShellVersion: typeof manifest.minShellVersion === 'string' ? manifest.minShellVersion : '',
    contentHash: typeof manifest.contentHash === 'string' ? manifest.contentHash : '',
    bundleUrl: typeof manifest.bundleUrl === 'string' ? manifest.bundleUrl : '',
    rollbackToBuiltin: manifest.rollbackToBuiltin === true,
    rollbackReason: typeof manifest.rollbackReason === 'string' ? manifest.rollbackReason : '',
    requiredShellCapabilities: sortedStringArray(manifest.requiredShellCapabilities),
    requiredRuntimeAssets: sortedStringArray(manifest.requiredRuntimeAssets),
    requiredResources: sortedStringArray(manifest.requiredResources),
  };
}

export function extractRendererManifestPayload(
  value,
  {
    publicKeys = getControlPlanePublicKeysFromEnv(),
    allowRawPayload = true,
    now,
  } = {},
) {
  if (!isControlPlaneEnvelopeLike(value)) {
    if (allowRawPayload && isRecord(value)) return normalizeRendererManifestPayload(value);
    throw new Error('renderer manifest must be a renderer_bundle envelope');
  }

  const trust = verifyControlPlaneEnvelope(value, {
    kind: 'renderer_bundle',
    publicKeys,
    ...(now !== undefined ? { now } : {}),
  });
  if (!trust.trusted || !trust.payload) {
    throw new Error(
      `renderer manifest envelope failed verification: ${trust.diagnostics.map((entry) => entry.code).join(', ')}`,
    );
  }
  return normalizeRendererManifestPayload(trust.payload);
}

function readManifestFile(filePath, options) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return extractRendererManifestPayload(parsed, options);
}

function valueForDiff(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return value || '';
}

export function buildRendererManifestDiff({ baseManifest, headManifest }) {
  if (!headManifest) {
    throw new Error('headManifest is required');
  }
  const baseCapabilities = baseManifest?.requiredShellCapabilities ?? [];
  const headCapabilities = headManifest.requiredShellCapabilities ?? [];
  const baseRuntimeAssets = baseManifest?.requiredRuntimeAssets ?? [];
  const headRuntimeAssets = headManifest.requiredRuntimeAssets ?? [];
  const baseResources = baseManifest?.requiredResources ?? [];
  const headResources = headManifest.requiredResources ?? [];
  const baseSet = new Set(baseCapabilities);
  const headSet = new Set(headCapabilities);
  const baseRuntimeAssetSet = new Set(baseRuntimeAssets);
  const headRuntimeAssetSet = new Set(headRuntimeAssets);
  const baseResourceSet = new Set(baseResources);
  const headResourceSet = new Set(headResources);
  const fieldChanges = baseManifest
    ? DIFF_FIELDS
      .map((field) => ({
        field,
        base: valueForDiff(baseManifest[field]),
        head: valueForDiff(headManifest[field]),
      }))
      .filter((change) => change.base !== change.head)
    : [];

  return {
    basePresent: Boolean(baseManifest),
    baseVersion: baseManifest?.version ?? null,
    headVersion: headManifest.version,
    baseRequiredShellCapabilitiesCount: baseCapabilities.length,
    headRequiredShellCapabilitiesCount: headCapabilities.length,
    baseRequiredRuntimeAssetsCount: baseRuntimeAssets.length,
    headRequiredRuntimeAssetsCount: headRuntimeAssets.length,
    baseRequiredResourcesCount: baseResources.length,
    headRequiredResourcesCount: headResources.length,
    fieldChanges,
    addedRequiredShellCapabilities: headCapabilities.filter((capability) => !baseSet.has(capability)),
    removedRequiredShellCapabilities: baseCapabilities.filter((capability) => !headSet.has(capability)),
    addedRequiredRuntimeAssets: headRuntimeAssets.filter((asset) => !baseRuntimeAssetSet.has(asset)),
    removedRequiredRuntimeAssets: baseRuntimeAssets.filter((asset) => !headRuntimeAssetSet.has(asset)),
    addedRequiredResources: headResources.filter((resource) => !baseResourceSet.has(resource)),
    removedRequiredResources: baseResources.filter((resource) => !headResourceSet.has(resource)),
  };
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatFieldChanges(changes) {
  if (changes.length === 0) {
    return '_None._';
  }
  return [
    '| Field | Current latest | Candidate |',
    '|---|---|---|',
    ...changes.map((change) => (
      `| ${escapeMarkdownCell(change.field)} | \`${escapeMarkdownCell(change.base || '(empty)')}\` | \`${escapeMarkdownCell(change.head || '(empty)')}\` |`
    )),
  ].join('\n');
}

function formatCapabilityList(capabilities, maxRows = 40) {
  if (capabilities.length === 0) {
    return '_None._';
  }
  const visible = capabilities.slice(0, maxRows);
  const rows = visible.map((capability) => `- \`${escapeMarkdownCell(capability)}\``);
  if (capabilities.length > visible.length) {
    rows.push(`- _Showing ${visible.length} of ${capabilities.length}._`);
  }
  return rows.join('\n');
}

export function formatRendererManifestDiffMarkdown(diff) {
  return [
    '# Renderer Manifest Diff',
    '',
    diff.basePresent
      ? `Current latest: ${diff.baseVersion || '(unknown)'} | Candidate: ${diff.headVersion || '(unknown)'}`
      : `Current latest: not found | Candidate: ${diff.headVersion || '(unknown)'}`,
    `Required shell capabilities: ${diff.baseRequiredShellCapabilitiesCount} -> ${diff.headRequiredShellCapabilitiesCount}`,
    `Required runtime assets: ${diff.baseRequiredRuntimeAssetsCount} -> ${diff.headRequiredRuntimeAssetsCount}`,
    `Required resources: ${diff.baseRequiredResourcesCount} -> ${diff.headRequiredResourcesCount}`,
    '',
    '## Manifest Fields',
    '',
    diff.basePresent
      ? formatFieldChanges(diff.fieldChanges)
      : '_No current latest manifest was available. Candidate will be compared as a first publish._',
    '',
    '## Added Required Shell Capabilities',
    '',
    formatCapabilityList(diff.addedRequiredShellCapabilities),
    '',
    '## Removed Required Shell Capabilities',
    '',
    formatCapabilityList(diff.removedRequiredShellCapabilities),
    '',
    '## Added Required Runtime Assets',
    '',
    formatCapabilityList(diff.addedRequiredRuntimeAssets),
    '',
    '## Removed Required Runtime Assets',
    '',
    formatCapabilityList(diff.removedRequiredRuntimeAssets),
    '',
    '## Added Required Resources',
    '',
    formatCapabilityList(diff.addedRequiredResources),
    '',
    '## Removed Required Resources',
    '',
    formatCapabilityList(diff.removedRequiredResources),
    '',
  ].join('\n');
}

function main() {
  const headManifestPath = readArg('--head-manifest-path');
  const baseManifestPath = readArg('--base-manifest-path');
  const summaryOutput = readArg('--summary-output') || process.env.GITHUB_STEP_SUMMARY;
  const jsonOutput = readArg('--json-output');
  const allowRawPayload = !hasFlag('--require-envelope');

  if (!headManifestPath) {
    throw new Error('renderer-manifest-diff requires --head-manifest-path');
  }

  const options = { allowRawPayload };
  const headManifest = readManifestFile(path.resolve(headManifestPath), options);
  // base 是当前已发布、即将被替换的 manifest，只用于展示 diff。签名/contentHash/kind 仍严格校验，
  // 但过期不能阻断本次重新签发——重新发布正是修复过期 manifest 的手段（now:1 关掉对 base 的过期判定）。
  const baseManifest = baseManifestPath
    ? readManifestFile(path.resolve(baseManifestPath), { ...options, now: 1 })
    : null;
  const diff = buildRendererManifestDiff({ baseManifest, headManifest });
  const markdown = formatRendererManifestDiffMarkdown(diff);

  process.stdout.write(`${markdown}\n`);
  if (summaryOutput) {
    fs.appendFileSync(summaryOutput, `${markdown}\n`, 'utf8');
  }
  if (jsonOutput) {
    fs.writeFileSync(jsonOutput, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

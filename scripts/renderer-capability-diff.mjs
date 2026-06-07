#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getShellCapabilityIds } from '../src/main/shellCapabilities.ts';
import { collectRendererShellCapabilities } from './renderer-capability-scanner.mjs';

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sortCapabilities(capabilities) {
  return [...capabilities].sort((a, b) => a.id.localeCompare(b.id));
}

function capabilityMap(capabilities) {
  return new Map(capabilities.map((capability) => [capability.id, capability]));
}

function countByLayer(capabilities) {
  return capabilities.reduce((counts, capability) => {
    const layer = capability.layer || (capability.id.startsWith('native:') ? 'native' : 'domain');
    counts[layer] = (counts[layer] || 0) + 1;
    return counts;
  }, {});
}

export function buildRendererCapabilityDiff({
  baseCapabilities,
  headCapabilities,
  supportedShellCapabilities = getShellCapabilityIds(),
}) {
  const baseMap = capabilityMap(baseCapabilities);
  const headMap = capabilityMap(headCapabilities);
  const supported = new Set(supportedShellCapabilities);

  return {
    baseCount: baseMap.size,
    headCount: headMap.size,
    added: sortCapabilities([...headMap.values()].filter((capability) => !baseMap.has(capability.id))),
    removed: sortCapabilities([...baseMap.values()].filter((capability) => !headMap.has(capability.id))),
    unsupported: sortCapabilities([...headMap.values()].filter((capability) => !supported.has(capability.id))),
    layers: {
      base: countByLayer([...baseMap.values()]),
      head: countByLayer([...headMap.values()]),
    },
  };
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatCapabilityTable(capabilities) {
  if (capabilities.length === 0) {
    return '_None._';
  }
  const rows = capabilities.map((capability) => (
    `| \`${escapeMarkdownCell(capability.id)}\` | ${escapeMarkdownCell(capability.layer || 'domain')} | \`${escapeMarkdownCell(capability.file)}\` |`
  ));
  return ['| Capability | Layer | First file |', '|---|---|---|', ...rows].join('\n');
}

export function formatRendererCapabilityDiffMarkdown(diff) {
  return [
    '# Renderer Capability Diff',
    '',
    `Base: ${diff.baseCount} | Head: ${diff.headCount} | Added: ${diff.added.length} | Removed: ${diff.removed.length}`,
    `Layers: base domain=${diff.layers?.base?.domain ?? 0}, native=${diff.layers?.base?.native ?? 0} | head domain=${diff.layers?.head?.domain ?? 0}, native=${diff.layers?.head?.native ?? 0}`,
    '',
    '## Added',
    '',
    formatCapabilityTable(diff.added),
    '',
    '## Removed',
    '',
    formatCapabilityTable(diff.removed),
    '',
    '## Unsupported By Current Shell',
    '',
    diff.unsupported.length === 0
      ? '_None. Head renderer calls are covered by the current shell capability manifest._'
      : formatCapabilityTable(diff.unsupported),
    '',
  ].join('\n');
}

export function scanRendererCapabilities({
  rendererDir,
  domainsPath,
  repoRoot,
}) {
  return collectRendererShellCapabilities({
    rendererDir,
    domainsPath,
    repoRoot,
  });
}

function main() {
  const headRepoRoot = path.resolve(readArg('--head-repo-root') || process.cwd());
  const baseRepoRoot = path.resolve(readArg('--base-repo-root') || headRepoRoot);
  const headRendererDir = path.resolve(readArg('--head-renderer-dir') || path.join(headRepoRoot, 'src/renderer'));
  const headDomainsPath = path.resolve(readArg('--head-domains-path') || path.join(headRepoRoot, 'src/shared/ipc/domains.ts'));
  const baseRendererDir = readArg('--base-renderer-dir');
  const baseDomainsPath = readArg('--base-domains-path');
  const summaryOutput = readArg('--summary-output') || process.env.GITHUB_STEP_SUMMARY;
  const jsonOutput = readArg('--json-output');
  const failOnUnsupported = hasFlag('--fail-on-unsupported');

  if (!baseRendererDir || !baseDomainsPath) {
    throw new Error('renderer-capability-diff requires --base-renderer-dir and --base-domains-path');
  }

  const baseCapabilities = scanRendererCapabilities({
    rendererDir: path.resolve(baseRendererDir),
    domainsPath: path.resolve(baseDomainsPath),
    repoRoot: baseRepoRoot,
  });
  const headCapabilities = scanRendererCapabilities({
    rendererDir: headRendererDir,
    domainsPath: headDomainsPath,
    repoRoot: headRepoRoot,
  });
  const diff = buildRendererCapabilityDiff({
    baseCapabilities,
    headCapabilities,
  });
  const markdown = formatRendererCapabilityDiffMarkdown(diff);

  process.stdout.write(`${markdown}\n`);
  if (summaryOutput) {
    fs.appendFileSync(summaryOutput, `${markdown}\n`, 'utf8');
  }
  if (jsonOutput) {
    fs.writeFileSync(jsonOutput, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
  }
  if (failOnUnsupported && diff.unsupported.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

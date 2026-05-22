#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultRoot = path.join(
  repoRoot,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'macos',
  'Agent Neo.app',
  'Contents',
  'Resources',
  '_up_',
);

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function toRelative(filePath, rootDir) {
  return toPosix(path.relative(rootDir, filePath));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(2)} TiB`;
}

function ensureInsideRepo(outputPath) {
  const resolved = path.resolve(repoRoot, outputPath);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside repo: ${outputPath}`);
  }
  return resolved;
}

function groupKeyFor(relativePath) {
  const segments = relativePath.split('/');
  if (segments[0] === 'node_modules') {
    if (segments[1]?.startsWith('@')) {
      return segments.slice(0, 3).join('/');
    }
    return segments.slice(0, 2).join('/');
  }

  if (segments[0] === 'dist' || segments[0] === 'scripts' || segments[0] === 'resources') {
    return segments.slice(0, 2).join('/');
  }

  return segments[0];
}

function classifyGroup(groupKey, bytes) {
  const large = bytes >= 1024 * 1024;

  if (groupKey === 'dist/web' || groupKey === 'dist/renderer') {
    return {
      placement: 'bundle-core',
      priority: 'P0 keep',
      rationale: 'App UI/server runtime; changes frequently and stays tied to the signed app shell.',
    };
  }

  if (groupKey === 'dist/native') {
    return {
      placement: 'managed-candidate',
      priority: 'P1 review',
      rationale: 'Native runtime assets can move later, but need code-path and signing verification first.',
    };
  }

  if (groupKey === 'node_modules/onnxruntime-node') {
    return {
      placement: 'managed-candidate',
      priority: 'P0 candidate',
      rationale: 'Large native inference runtime; good first managed runtime candidate if callers can resolve an external path.',
    };
  }

  if (groupKey === 'node_modules/avr-vad') {
    return {
      placement: 'managed-candidate',
      priority: 'P0 candidate',
      rationale: 'VAD model assets travel with onnxruntime-node for the first managed runtime pilot.',
    };
  }

  if (groupKey === 'node_modules/playwright' || groupKey === 'node_modules/playwright-core') {
    return {
      placement: 'managed-candidate',
      priority: 'P0 candidate',
      rationale: 'Large browser automation runtime; suitable for optional download with bundle fallback.',
    };
  }

  if (
    groupKey.startsWith('node_modules/@img/')
    || groupKey === 'node_modules/sharp'
  ) {
    return {
      placement: 'optional-candidate',
      priority: 'P1 candidate',
      rationale: 'Feature-specific native/media runtime; useful after the first resolver path is proven.',
    };
  }

  if (
    groupKey === 'scripts/vision-ocr'
    || groupKey === 'scripts/vision-tagger'
    || groupKey === 'scripts/system-audio-capture'
  ) {
    return {
      placement: 'optional-candidate',
      priority: 'P1 candidate',
      rationale: 'Signed helper executable; can move only with helper signing, hash verification, and fallback.',
    };
  }

  if (
    groupKey === 'node_modules/better-sqlite3'
    || groupKey === 'node_modules/keytar'
    || groupKey === 'node_modules/node-pty'
  ) {
    return {
      placement: 'bundle-core',
      priority: 'P0 keep',
      rationale: 'Core local data, credential, or terminal runtime; moving it raises startup and support risk.',
    };
  }

  if (groupKey === 'package.json') {
    return {
      placement: 'bundle-core',
      priority: 'P0 keep',
      rationale: 'Runtime package metadata used by bundled Node code.',
    };
  }

  return {
    placement: large ? 'review' : 'bundle-core',
    priority: large ? 'P1 review' : 'P0 keep',
    rationale: large
      ? 'Large enough to review, but no managed-runtime rule exists yet.'
      : 'Small item; splitting it out is unlikely to pay for its complexity.',
  };
}

function walk(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        files.push({
          path: fullPath,
          relativePath: toRelative(fullPath, rootDir),
          bytes: stat.size,
        });
      }
    }
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function sha256Group(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function buildInventory(rootDir) {
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Resource root does not exist: ${rootDir}`);
  }

  const files = walk(rootDir).map((file) => ({
    ...file,
    sha256: sha256File(file.path),
  }));

  const groupMap = new Map();
  const topLevelMap = new Map();

  for (const file of files) {
    const groupKey = groupKeyFor(file.relativePath);
    const topLevelKey = file.relativePath.split('/')[0];
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, []);
    }
    if (!topLevelMap.has(topLevelKey)) {
      topLevelMap.set(topLevelKey, []);
    }
    groupMap.get(groupKey).push(file);
    topLevelMap.get(topLevelKey).push(file);
  }

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const groups = [...groupMap.entries()].map(([key, groupFiles]) => {
    const bytes = groupFiles.reduce((sum, file) => sum + file.bytes, 0);
    const classification = classifyGroup(key, bytes);
    return {
      key,
      bytes,
      formattedSize: formatBytes(bytes),
      fileCount: groupFiles.length,
      sha256: sha256Group(groupFiles),
      ...classification,
    };
  }).sort((left, right) => right.bytes - left.bytes || left.key.localeCompare(right.key));

  const topLevel = [...topLevelMap.entries()].map(([key, groupFiles]) => {
    const bytes = groupFiles.reduce((sum, file) => sum + file.bytes, 0);
    return {
      key,
      bytes,
      formattedSize: formatBytes(bytes),
      fileCount: groupFiles.length,
    };
  }).sort((left, right) => right.bytes - left.bytes || left.key.localeCompare(right.key));

  const largestFiles = [...files]
    .sort((left, right) => right.bytes - left.bytes || left.relativePath.localeCompare(right.relativePath))
    .slice(0, 25)
    .map((file) => ({
      path: file.relativePath,
      bytes: file.bytes,
      formattedSize: formatBytes(file.bytes),
      sha256: file.sha256,
    }));

  const byPlacement = groups.reduce((acc, group) => {
    acc[group.placement] ??= { bytes: 0, fileCount: 0, groupCount: 0 };
    acc[group.placement].bytes += group.bytes;
    acc[group.placement].fileCount += group.fileCount;
    acc[group.placement].groupCount += 1;
    return acc;
  }, {});

  for (const value of Object.values(byPlacement)) {
    value.formattedSize = formatBytes(value.bytes);
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root: rootDir,
    summary: {
      totalBytes,
      totalSize: formatBytes(totalBytes),
      fileCount: files.length,
      groupCount: groups.length,
      byPlacement,
    },
    topLevel,
    groups,
    largestFiles,
  };
}

function markdownTable(rows, columns) {
  const header = `| ${columns.map((column) => column.title).join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(column.value(row)).replace(/\n/g, ' ')).join(' | ')} |`);
  return [header, separator, ...body].join('\n');
}

function buildMarkdown(inventory) {
  const managed = inventory.groups.filter((group) => group.placement.includes('candidate'));
  const review = inventory.groups.filter((group) => group.placement === 'review');
  const keep = inventory.groups.filter((group) => group.placement === 'bundle-core');
  const byPlacement = Object.entries(inventory.summary.byPlacement)
    .sort(([, left], [, right]) => right.bytes - left.bytes)
    .map(([placement, value]) => ({
      placement,
      size: value.formattedSize,
      groups: value.groupCount,
      files: value.fileCount,
    }));

  return `# Runtime Assets Inventory

Generated: ${inventory.generatedAt}

Root: \`${inventory.root}\`

## Summary

- Total size: ${inventory.summary.totalSize}
- Files: ${inventory.summary.fileCount}
- Groups: ${inventory.summary.groupCount}

${markdownTable(byPlacement, [
    { title: 'Placement', value: (row) => row.placement },
    { title: 'Size', value: (row) => row.size },
    { title: 'Groups', value: (row) => row.groups },
    { title: 'Files', value: (row) => row.files },
  ])}

## Top Level

${markdownTable(inventory.topLevel, [
    { title: 'Path', value: (row) => `\`${row.key}\`` },
    { title: 'Size', value: (row) => row.formattedSize },
    { title: 'Files', value: (row) => row.fileCount },
  ])}

## Managed Runtime Candidates

${markdownTable(managed, [
    { title: 'Group', value: (row) => `\`${row.key}\`` },
    { title: 'Size', value: (row) => row.formattedSize },
    { title: 'Priority', value: (row) => row.priority },
    { title: 'Rationale', value: (row) => row.rationale },
  ])}

## Review Later

${review.length > 0 ? markdownTable(review, [
    { title: 'Group', value: (row) => `\`${row.key}\`` },
    { title: 'Size', value: (row) => row.formattedSize },
    { title: 'Files', value: (row) => row.fileCount },
    { title: 'Rationale', value: (row) => row.rationale },
  ]) : 'No large unclassified groups.'}

## Keep In App Shell

${markdownTable(keep, [
    { title: 'Group', value: (row) => `\`${row.key}\`` },
    { title: 'Size', value: (row) => row.formattedSize },
    { title: 'Reason', value: (row) => row.rationale },
  ])}

## Largest Files

${markdownTable(inventory.largestFiles.slice(0, 15), [
    { title: 'File', value: (row) => `\`${row.path}\`` },
    { title: 'Size', value: (row) => row.formattedSize },
    { title: 'SHA-256', value: (row) => `\`${row.sha256.slice(0, 12)}...\`` },
  ])}

## P0 Recommendation

Continue the managed runtime path instead of a binary patch updater:

1. Keep the Tauri app shell on the existing signed full-package updater path.
2. Move each large candidate only after resolver, fallback, hash verification, and rollback behavior are proven.
3. Keep native helpers and database/credential/terminal modules in the signed app until signing and rollback behavior is proven.
4. Re-run this inventory after each release bundle to measure actual size movement.
`;
}

function printSummary(inventory) {
  console.log(`[tauri-resource-inventory] root: ${inventory.root}`);
  console.log(`[tauri-resource-inventory] total: ${inventory.summary.totalSize} (${inventory.summary.fileCount} files, ${inventory.summary.groupCount} groups)`);
  console.log('[tauri-resource-inventory] top groups:');
  for (const group of inventory.groups.slice(0, 12)) {
    console.log(`  ${group.formattedSize.padStart(10)}  ${group.key}  ${group.placement}  ${group.priority}`);
  }
}

const rootDir = path.resolve(readArg('--root') || process.env.TAURI_RESOURCE_ROOT || defaultRoot);
const jsonOutput = readArg('--json-output');
const markdownOutput = readArg('--markdown-output');

const inventory = buildInventory(rootDir);

if (jsonOutput) {
  const outputPath = ensureInsideRepo(jsonOutput);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(`[tauri-resource-inventory] wrote JSON: ${path.relative(repoRoot, outputPath)}`);
}

if (markdownOutput) {
  const outputPath = ensureInsideRepo(markdownOutput);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buildMarkdown(inventory));
  console.log(`[tauri-resource-inventory] wrote Markdown: ${path.relative(repoRoot, outputPath)}`);
}

if (!jsonOutput || hasFlag('--print-json')) {
  printSummary(inventory);
}

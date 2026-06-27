#!/usr/bin/env node
/* global console */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const args = process.argv.slice(2);

function hasArg(name) {
  return args.includes(name);
}

function getNumberArg(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return fallback;
  const parsed = Number.parseInt(args[index + 1], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const jsonOnly = hasArg('--json') || hasArg('--format=json');
const skipEslint = hasArg('--skip-eslint') || process.env.DEBT_REPORT_SKIP_ESLINT === '1';
const limit = getNumberArg('--limit', 20);
const maxLineThreshold = getNumberArg('--max-lines', 1000);

const sourceExtensions = new Set(['.ts', '.tsx']);
const ignoredDirSegments = new Set([
  'node_modules',
  'dist',
  'release',
  'cloud-api',
  'vercel-api',
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function toRepoRelative(filePath) {
  return toPosix(path.relative(repoRoot, filePath));
}

function shouldSkipDir(dirPath) {
  const relative = toRepoRelative(dirPath);
  if (!relative || relative === '.') return false;
  const parts = relative.split('/');
  if (parts.some((part) => ignoredDirSegments.has(part))) return true;
  return relative.startsWith('benchmarks/swe-bench/sandbox/')
    || relative.startsWith('benchmarks/swe-bench/runs/')
    || relative.startsWith('benchmarks/swe-bench/_docker-tmp/');
}

function isSourceFile(filePath) {
  const relative = toRepoRelative(filePath);
  return relative.startsWith('src/')
    && sourceExtensions.has(path.extname(filePath))
    && !isTestLikeFile(relative);
}

function isTestLikeFile(relativePath) {
  return relativePath.includes('/__tests__/')
    || relativePath.includes('/tests/')
    || /\.(test|spec)\.(ts|tsx)$/.test(relativePath);
}

function walk(dir, visit) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDir(fullPath)) {
        walk(fullPath, visit);
      }
      continue;
    }
    if (entry.isFile()) {
      visit(fullPath);
    }
  }
}

function readHistoricalGodFileWhitelist() {
  const configPath = path.join(repoRoot, 'eslint.config.js');
  const content = fs.readFileSync(configPath, 'utf8');
  const marker = 'God File 历史白名单';
  const markerIndex = content.indexOf(marker);
  if (markerIndex === -1) return [];

  const filesIndex = content.indexOf('files: [', markerIndex);
  if (filesIndex === -1) return [];

  const closeIndex = content.indexOf('],', filesIndex);
  if (closeIndex === -1) return [];

  const block = content.slice(filesIndex, closeIndex);
  const paths = [];
  const pattern = /['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(block))) {
    if (match[1].startsWith('src/')) {
      paths.push(match[1]);
    }
  }
  return paths;
}

function countLines(content) {
  const lines = content.split(/\r?\n/);
  let effective = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) continue;
    effective += 1;
  }
  return {
    physical: lines.length,
    effective,
  };
}

function bucketFor(relativePath) {
  const parts = relativePath.split('/');
  if (parts.length <= 3) return parts.join('/');
  if (parts[0] === 'src' && parts[1] === 'web' && parts[2] === 'routes') {
    return 'src/web/routes';
  }
  if (parts[0] === 'src' && parts[1] === 'main' && parts[2] === 'model' && parts[3] === 'providers') {
    return 'src/host/model/providers';
  }
  if (parts[0] === 'src' && parts[1] === 'main' && parts[2] === 'tools' && parts[3]) {
    return `src/host/tools/${parts[3]}`;
  }
  if (parts[0] === 'src' && parts[1] === 'main' && parts[2] === 'ipc') {
    return 'src/host/ipc';
  }
  return parts.slice(0, 4).join('/');
}

function increment(map, key, count = 1) {
  map.set(key, (map.get(key) || 0) + count);
}

function topEntries(map, entryLimit = limit) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, entryLimit)
    .map(([name, count]) => ({ name, count }));
}

function scanSources() {
  const whitelist = new Set(readHistoricalGodFileWhitelist());
  const files = [];
  const disableByFile = new Map();
  const disableByBucket = new Map();
  const asAnyByFile = new Map();
  const asAnyByBucket = new Map();
  let noExplicitAnyDisableCount = 0;
  let asAnyCount = 0;

  walk(path.join(repoRoot, 'src'), (filePath) => {
    if (!isSourceFile(filePath)) return;

    const relative = toRepoRelative(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = countLines(content);
    const bucket = bucketFor(relative);

    files.push({
      path: relative,
      bucket,
      physicalLines: lines.physical,
      effectiveLines: lines.effective,
      inGodFileWhitelist: whitelist.has(relative),
      overPhysicalLimit: lines.physical > maxLineThreshold,
      overEffectiveLimit: lines.effective > maxLineThreshold,
    });

    const disableMatches = content.match(/eslint-disable-next-line\s+@typescript-eslint\/no-explicit-any/g) || [];
    if (disableMatches.length > 0) {
      noExplicitAnyDisableCount += disableMatches.length;
      increment(disableByFile, relative, disableMatches.length);
      increment(disableByBucket, bucket, disableMatches.length);
    }

    const asAnyMatches = content.match(/\bas\s+any\b/g) || [];
    if (asAnyMatches.length > 0) {
      asAnyCount += asAnyMatches.length;
      increment(asAnyByFile, relative, asAnyMatches.length);
      increment(asAnyByBucket, bucket, asAnyMatches.length);
    }
  });

  const largeFiles = files
    .filter((file) => file.physicalLines > maxLineThreshold || file.effectiveLines > maxLineThreshold)
    .sort((left, right) => right.physicalLines - left.physicalLines || left.path.localeCompare(right.path));

  return {
    sourceFileCount: files.length,
    largeFiles,
    topLargeFiles: largeFiles.slice(0, limit),
    maxLines: {
      physicalOverLimit: files.filter((file) => file.overPhysicalLimit).length,
      effectiveOverLimit: files.filter((file) => file.overEffectiveLimit).length,
      effectiveOverLimitNotWhitelisted: files
        .filter((file) => file.overEffectiveLimit && !file.inGodFileWhitelist)
        .map((file) => file.path)
        .sort(),
      whitelistCount: whitelist.size,
      whitelistMissingFromSource: [...whitelist].filter((file) => !files.some((source) => source.path === file)).sort(),
    },
    anyDebt: {
      noExplicitAnyDisableCount,
      asAnyCount,
      noExplicitAnyDisableHotFiles: topEntries(disableByFile),
      noExplicitAnyDisableHotBuckets: topEntries(disableByBucket),
      asAnyHotFiles: topEntries(asAnyByFile),
      asAnyHotBuckets: topEntries(asAnyByBucket),
    },
  };
}

function parseEslintJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

function runEslintNoUnsafeReport() {
  if (skipEslint) {
    return { skipped: true };
  }

  let stdout = '';
  let exitCode = 0;
  let stderr = '';

  try {
    stdout = execFileSync(
      'npx',
      ['eslint', 'src', '--ext', '.ts,.tsx', '--format', 'json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    stdout = error.stdout?.toString() || '';
    stderr = error.stderr?.toString() || '';
    exitCode = typeof error.status === 'number' ? error.status : 1;
  }

  try {
    const results = parseEslintJson(stdout);
    const byRule = new Map();
    const byFile = new Map();
    const byBucket = new Map();
    let total = 0;

    for (const result of results) {
      const relative = toRepoRelative(result.filePath);
      for (const message of result.messages || []) {
        if (!message.ruleId?.startsWith('@typescript-eslint/no-unsafe-')) continue;
        total += 1;
        increment(byRule, message.ruleId);
        increment(byFile, relative);
        increment(byBucket, bucketFor(relative));
      }
    }

    return {
      skipped: false,
      exitCode,
      totalNoUnsafeWarnings: total,
      byRule: topEntries(byRule, 10),
      hotFiles: topEntries(byFile),
      hotBuckets: topEntries(byBucket),
      stderr: stderr.trim() || undefined,
    };
  } catch (error) {
    return {
      skipped: false,
      exitCode,
      parseError: error instanceof Error ? error.message : String(error),
      stderr: stderr.trim() || undefined,
    };
  }
}

function buildReport() {
  const sourceScan = scanSources();
  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    threshold: {
      maxLines: maxLineThreshold,
    },
    ...sourceScan,
    eslintNoUnsafe: runEslintNoUnsafeReport(),
  };
}

function printTable(rows, columns) {
  const widths = columns.map((column) => {
    const headerWidth = column.header.length;
    const cellWidth = rows.reduce((max, row) => Math.max(max, String(column.value(row)).length), 0);
    return Math.max(headerWidth, cellWidth);
  });

  const header = columns.map((column, index) => column.header.padEnd(widths[index])).join('  ');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  console.log(header);
  console.log(divider);
  for (const row of rows) {
    console.log(columns.map((column, index) => String(column.value(row)).padEnd(widths[index])).join('  '));
  }
}

function printHuman(report) {
  console.log('Architecture Debt Report');
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Source files: ${report.sourceFileCount}`);
  console.log(`Max-lines threshold: ${report.threshold.maxLines}`);
  console.log('');

  console.log('Large files');
  printTable(report.topLargeFiles, [
    { header: 'physical', value: (row) => row.physicalLines },
    { header: 'effective', value: (row) => row.effectiveLines },
    { header: 'whitelist', value: (row) => (row.inGodFileWhitelist ? 'yes' : 'no') },
    { header: 'path', value: (row) => row.path },
  ]);
  console.log('');
  console.log(`Physical > limit: ${report.maxLines.physicalOverLimit}`);
  console.log(`Effective > limit: ${report.maxLines.effectiveOverLimit}`);
  console.log(`Effective > limit and not whitelisted: ${report.maxLines.effectiveOverLimitNotWhitelisted.length}`);
  for (const file of report.maxLines.effectiveOverLimitNotWhitelisted.slice(0, limit)) {
    console.log(`  - ${file}`);
  }
  console.log('');

  console.log('Any debt');
  console.log(`no-explicit-any inline disables: ${report.anyDebt.noExplicitAnyDisableCount}`);
  console.log(`as any casts: ${report.anyDebt.asAnyCount}`);
  console.log('');
  console.log('no-explicit-any hot buckets');
  printTable(report.anyDebt.noExplicitAnyDisableHotBuckets, [
    { header: 'count', value: (row) => row.count },
    { header: 'bucket', value: (row) => row.name },
  ]);
  console.log('');
  console.log('as any hot buckets');
  printTable(report.anyDebt.asAnyHotBuckets, [
    { header: 'count', value: (row) => row.count },
    { header: 'bucket', value: (row) => row.name },
  ]);
  console.log('');

  console.log('no-unsafe ESLint hotspots');
  if (report.eslintNoUnsafe.skipped) {
    console.log('skipped');
  } else if (report.eslintNoUnsafe.parseError) {
    console.log(`parse failed: ${report.eslintNoUnsafe.parseError}`);
  } else {
    console.log(`total warnings: ${report.eslintNoUnsafe.totalNoUnsafeWarnings}`);
    printTable(report.eslintNoUnsafe.hotBuckets, [
      { header: 'count', value: (row) => row.count },
      { header: 'bucket', value: (row) => row.name },
    ]);
  }
}

const report = buildReport();

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}

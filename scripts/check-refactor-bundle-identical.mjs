#!/usr/bin/env node
/* global console */
// check-refactor-bundle-identical — manual proof that a refactor preserved a bundle
//
// Usage:
//   node scripts/check-refactor-bundle-identical.mjs <entry> [--base <ref>] [--expect <regex> ...]
//
// esbuild adds one `// <path>` marker per source module. The marker and its
// preceding separator line are removed before hashing; no other normalization is
// applied. The fixed bundle options keep this check independent of production
// build configuration and leave node_modules external.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const DEFAULT_BASE = 'origin/main';
const MODULE_PATH_COMMENT = /^\/\/ (?:(?:[A-Za-z]:[\\/])|\/|\.\.?[\\/]|.*\.[A-Za-z0-9]+\s*)$/;
const BUNDLE_OPTIONS = {
  bundle: true,
  minify: false,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  packages: 'external',
  legalComments: 'none',
  write: false,
};

function usageError(message) {
  return new Error(`Usage error: ${message}`);
}

export function parseArgs(args) {
  let entry;
  let base = DEFAULT_BASE;
  const expects = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--base' || arg === '--expect') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw usageError(`${arg} requires a value`);
      }
      if (arg === '--base') base = value;
      else expects.push(value);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }
    if (arg.startsWith('--')) throw usageError(`unknown option: ${arg}`);
    if (entry) throw usageError(`only one entry is supported (received ${arg})`);
    entry = arg;
  }

  if (!entry) throw usageError('an entry path is required');
  return { entry, base, expects };
}

export function normalizeBundle(bundle) {
  const lines = bundle.split(/\r?\n/);
  const normalized = [];
  for (const line of lines) {
    if (MODULE_PATH_COMMENT.test(line)) {
      if (normalized.at(-1) === '') normalized.pop();
      continue;
    }
    normalized.push(line);
  }
  return normalized.join('\n');
}

export function hashBundle(bundle) {
  return createHash('sha256').update(bundle, 'utf8').digest('hex');
}

export function firstDiffBlock(left, right) {
  const leftLines = left.split(/\r?\n/);
  const rightLines = right.split(/\r?\n/);
  const differing = leftLines.findIndex((line, index) => line !== rightLines[index]);
  const first = differing >= 0 ? differing : Math.min(leftLines.length, rightLines.length);
  if (leftLines[first] === rightLines[first] && leftLines.length === rightLines.length) return null;

  const start = Math.max(0, first - 2);
  const end = Math.max(leftLines.length, rightLines.length, first + 1);
  const lines = [`first differing line: ${first + 1}`];
  for (let index = start; index < Math.min(end, first + 3); index += 1) {
    lines.push(`- base ${index + 1}: ${leftLines[index] ?? '<EOF>'}`);
    lines.push(`+ work ${index + 1}: ${rightLines[index] ?? '<EOF>'}`);
  }
  return lines.join('\n');
}

export function scanForPattern(text, regex) {
  const pattern = regex instanceof RegExp ? regex : new RegExp(regex);
  const previousLastIndex = pattern.lastIndex;
  pattern.lastIndex = 0;
  let hits = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    hits += 1;
    if (!pattern.global) break;
    // A zero-width match leaves lastIndex at match.index; step past it or exec
    // returns the same empty match forever (the guard must look at the match,
    // not at lastIndex, since the stall happens at any position).
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  pattern.lastIndex = previousLastIndex;
  if (hits === 0) throw new Error(`expected pattern had zero hits: ${pattern}`);
  return hits;
}

function bundleEntry({ entry, root, metafile = false }) {
  const entryPath = resolve(root, entry);
  return buildSync({
    ...BUNDLE_OPTIONS,
    absWorkingDir: root,
    entryPoints: [entryPath],
    metafile,
  });
}

function reachableSourceText({ entry, root }) {
  const result = bundleEntry({ entry, root, metafile: true });
  return Object.keys(result.metafile?.inputs ?? {})
    .map((input) => readFileSync(resolve(root, input), 'utf8'))
    .join('\n');
}

function parseExpectedRegex(value) {
  if (value.startsWith('/') && value.lastIndexOf('/') > 0) {
    const separator = value.lastIndexOf('/');
    const source = value.slice(1, separator);
    const flags = value.slice(separator + 1);
    return new RegExp(source, flags);
  }
  return new RegExp(value);
}

export function compareBundles({ entry, baseRoot, workRoot }) {
  const base = normalizeBundle(bundleEntry({ entry, root: baseRoot }).outputFiles[0].text);
  const work = normalizeBundle(bundleEntry({ entry, root: workRoot }).outputFiles[0].text);
  const baseSha = hashBundle(base);
  const workSha = hashBundle(work);
  const identical = baseSha === workSha;
  return {
    identical,
    baseSha,
    workSha,
    diff: identical ? null : firstDiffBlock(base, work),
  };
}

function materializeBase(baseRef, workRoot) {
  const baseRoot = mkdtempSync(join(tmpdir(), 'refactor-bundle-base-'));
  const archive = spawnSync('git', ['archive', baseRef], {
    cwd: workRoot,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archive.error || archive.status !== 0) {
    rmSync(baseRoot, { recursive: true, force: true });
    throw usageError(`could not archive base ${baseRef}: ${archive.stderr?.toString().trim() || archive.error?.message || `status=${archive.status}`}`);
  }
  const extracted = spawnSync('tar', ['-x', '-f', '-', '-C', baseRoot], {
    cwd: workRoot,
    input: archive.stdout,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (extracted.error || extracted.status !== 0) {
    rmSync(baseRoot, { recursive: true, force: true });
    throw new Error(`could not extract base ${baseRef}: ${extracted.stderr?.trim() || extracted.error?.message || `status=${extracted.status}`}`);
  }
  return baseRoot;
}

function printUsage() {
  console.error('Usage: node scripts/check-refactor-bundle-identical.mjs <entry> [--base <ref>] [--expect <regex> ...]');
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      printUsage();
      return 0;
    }
  } catch (error) {
    printUsage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const workRoot = resolve(process.cwd());
  let baseRoot;
  try {
    baseRoot = materializeBase(parsed.base, workRoot);
    const result = compareBundles({ entry: parsed.entry, baseRoot, workRoot });
    console.log(`base sha256: ${result.baseSha}`);
    console.log(`work sha256: ${result.workSha}`);
    if (!result.identical) {
      console.error('bundles differ');
      console.error(result.diff ?? '(no diff block)');
      return 1;
    }

    for (const expected of parsed.expects) {
      const regex = parseExpectedRegex(expected);
      const workBundle = normalizeBundle(bundleEntry({ entry: parsed.entry, root: workRoot }).outputFiles[0].text);
      scanForPattern(workBundle, regex);
      scanForPattern(reachableSourceText({ entry: parsed.entry, root: workRoot }), regex);
    }
    console.log('bundles identical');
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    if (baseRoot) rmSync(baseRoot, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}

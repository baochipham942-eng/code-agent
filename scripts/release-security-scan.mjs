#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const defaultRoots = [
  'dist/renderer',
  'dist/web',
  'dist/cli',
  'dist/bridge',
].map((item) => path.join(repoRoot, item));

const roots = process.argv.slice(2).map((item) => path.resolve(item));
const scanRoots = (roots.length > 0 ? roots : defaultRoots).filter((item) => fs.existsSync(item));

const sensitiveBasenames = new Set([
  '.dev-token',
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
  'id_rsa',
  'id_ed25519',
]);

const sourceExtensions = new Set(['.ts', '.tsx', '.rs', '.swift']);
const sourceMapCommentPattern = /[#@]\s*sourceMappingURL=/;

const violations = [];
const warnings = [];
let scannedFiles = 0;

function toDisplayPath(filePath) {
  const relative = path.relative(repoRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isThirdParty(filePath) {
  return toPosix(toDisplayPath(filePath)).includes('/node_modules/');
}

function isSensitiveName(basename) {
  if (sensitiveBasenames.has(basename)) return true;
  return /\.(pem|p12|pfx|mobileprovision)$/i.test(basename)
    || /(^|[-_.])(private[-_]?key|service[-_]?role|secret|credential)([-_.]|$)/i.test(basename);
}

function recordViolation(filePath, reason) {
  violations.push(`${toDisplayPath(filePath)} - ${reason}`);
}

function walk(dir, visit) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, visit);
      continue;
    }
    if (entry.isFile()) {
      visit(fullPath);
    }
  }
}

function scanFile(filePath) {
  scannedFiles += 1;
  const basename = path.basename(filePath);
  const ext = path.extname(filePath);
  const thirdParty = isThirdParty(filePath);
  const display = toPosix(toDisplayPath(filePath));

  if (isSensitiveName(basename)) {
    recordViolation(filePath, 'sensitive local credential file must not ship in a release bundle');
    return;
  }

  if (!thirdParty && ext === '.map') {
    recordViolation(filePath, 'first-party source map must not ship in a release bundle');
    return;
  }

  if (thirdParty && ext === '.map') {
    warnings.push(`${toDisplayPath(filePath)} - third-party source map`);
    return;
  }

  if (!thirdParty && sourceExtensions.has(ext)) {
    recordViolation(filePath, 'first-party source file must not ship in a release bundle');
    return;
  }

  if (!thirdParty && (display.includes('/docs/') || display.includes('/tests/') || display.includes('/src/'))) {
    recordViolation(filePath, 'first-party docs, tests, or src tree must not ship in a release bundle');
    return;
  }

  if (!thirdParty && ['.js', '.cjs', '.mjs', '.html'].includes(ext)) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (sourceMapCommentPattern.test(content)) {
      recordViolation(filePath, 'sourceMappingURL comment points reverse engineers to source maps');
    }
  }
}

for (const root of scanRoots) {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    scanFile(root);
  } else if (stat.isDirectory()) {
    walk(root, scanFile);
  }
}

if (scanRoots.length === 0) {
  console.log('[release-security-scan] no build artifacts found; nothing to scan');
  process.exit(0);
}

if (warnings.length > 0) {
  const shown = warnings.slice(0, 20);
  console.warn(`[release-security-scan] warnings: ${warnings.length}`);
  for (const warning of shown) {
    console.warn(`  - ${warning}`);
  }
  if (warnings.length > shown.length) {
    console.warn(`  ... ${warnings.length - shown.length} more`);
  }
}

if (violations.length > 0) {
  console.error(`[release-security-scan] failed: ${violations.length} release leak(s) found`);
  for (const violation of violations.slice(0, 80)) {
    console.error(`  - ${violation}`);
  }
  if (violations.length > 80) {
    console.error(`  ... ${violations.length - 80} more`);
  }
  process.exit(1);
}

console.log(`[release-security-scan] passed: ${scannedFiles} files scanned`);

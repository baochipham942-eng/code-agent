#!/usr/bin/env node
// Fail if scanned text contains a candidate whose HMAC-SHA256(salt, candidate)
// is listed in SENSITIVE_HASHES. The matched text is never printed.
// Hit lines are "<file>:<line> <hash prefix>".
//
//   SENSITIVE_SALT     HMAC key
//   SENSITIVE_HASHES   comma or newline separated sha256 hex
//
// Both unset (or the hash list empty): a warning on stderr and exit 0.
// --require (CI on push to main): exit 2 when the check is not configured.
// --staged: index blobs of staged adds/copies/modifications.
// --git-history: additions in `git log -p --all`, plus commit author,
//   email, and message. Paths and the hash prefix only.
// Other arguments are files or directories. No arguments scans the
// working directory. node_modules, .git, coverage, .next, target, and
// dist are skipped unless a path argument is inside dist.

import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { extractCandidates, HASH_PREFIX_LEN, hmacSha256Hex } from './sensitive-hash-lib.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage', '.next', 'target']);

function fail(message) {
  process.stderr.write(`sensitive-hash: ERROR: ${message}\n`);
  process.exit(2);
}

function usage() {
  return [
    'Usage: node scripts/security/check-sensitive-hashes.mjs [--require] [--staged | --git-history | path...]',
    'Env: SENSITIVE_SALT, SENSITIVE_HASHES (comma or newline separated HMAC-SHA256 hex).',
    'Unset: warning and exit 0. With --require: exit 2.',
    'A hit prints file:line and a hash prefix. The matched text is never printed.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { require: false, staged: false, gitHistory: false, help: false, paths: [] };
  for (const arg of argv) {
    if (arg === '--require') opts.require = true;
    else if (arg === '--staged') opts.staged = true;
    else if (arg === '--git-history') opts.gitHistory = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--')) fail(`unknown argument: ${arg}\n${usage()}`);
    else opts.paths.push(arg);
  }
  return opts;
}

function parseHashList(raw) {
  const hashes = String(raw ?? '')
    .split(/[,\r\n]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const invalid = hashes.filter((hash) => !/^[0-9a-f]{64}$/.test(hash));
  return { hashes, invalid };
}

function loadConfig(env) {
  const salt = (env.SENSITIVE_SALT ?? '').trim();
  const parsed = parseHashList(env.SENSITIVE_HASHES);
  return {
    salt,
    hashes: parsed.hashes,
    invalid: parsed.invalid,
    configured: salt.length > 0 && parsed.hashes.length > 0 && parsed.invalid.length === 0,
  };
}

function displayPath(abs) {
  const rel = path.relative(process.cwd(), abs);
  const normalized = rel.split(path.sep).join('/');
  if (!normalized || normalized.startsWith('..')) return abs.split(path.sep).join('/');
  return normalized;
}

function splitLines(text) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function createScan(salt, hashSet) {
  const hits = [];
  const seen = new Set();
  const digests = new Map();
  function consider(label, lineNumber, text) {
    if (!text) return;
    for (const candidate of extractCandidates(text)) {
      let digest = digests.get(candidate);
      if (!digest) {
        digest = hmacSha256Hex(salt, candidate);
        digests.set(candidate, digest);
      }
      // Full-digest membership. Output keeps a prefix so the matched text stays off the log.
      if (hashSet.has(digest)) {
        const id = `${label}:${lineNumber}:${digest}`;
        if (seen.has(id)) continue;
        seen.add(id);
        hits.push(`${label}:${lineNumber} ${digest.slice(0, HASH_PREFIX_LEN)}`);
      }
    }
  }
  return { hits, consider };
}

function readTextFile(abs) {
  let info;
  try {
    info = statSync(abs);
  } catch (error) {
    throw new Error(`cannot stat ${displayPath(abs)}: ${error.message}`);
  }
  if (!info.isFile()) return null;
  if (info.size > MAX_BYTES) {
    process.stderr.write(`sensitive-hash: skip large file ${displayPath(abs)}\n`);
    return null;
  }
  const buf = readFileSync(abs);
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

function scanText(label, text, scan) {
  const lines = splitLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    scan.consider(label, index + 1, lines[index]);
  }
}

function walk(dir, allowDist, scan) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read ${displayPath(dir)}: ${error.message}`);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name === 'dist' && !allowDist) continue;
      walk(abs, allowDist, scan);
      continue;
    }
    if (!entry.isFile()) continue;
    const text = readTextFile(abs);
    if (text === null) continue;
    scanText(displayPath(abs), text, scan);
  }
}

function allowDist(targets) {
  return targets.some((target) => path.resolve(target).split(path.sep).includes('dist'));
}

function scanPaths(targets, scan) {
  const distOk = allowDist(targets);
  for (const target of targets) {
    const abs = path.resolve(target);
    let info;
    try {
      info = lstatSync(abs);
    } catch (error) {
      throw new Error(`cannot read ${target}: ${error.message}`);
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      walk(abs, distOk, scan);
      continue;
    }
    const text = readTextFile(abs);
    if (text === null) continue;
    scanText(displayPath(abs), text, scan);
  }
}

function git(args, { maxBuffer = 10 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', args, { maxBuffer });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    const detail = result.stderr?.toString('utf8').trim() || `exit ${result.status}`;
    throw new Error(detail);
  }
  return result.stdout;
}

function repoRoot() {
  return git(['rev-parse', '--show-toplevel']).toString('utf8').trim();
}

function scanStaged(scan) {
  const root = repoRoot();
  const listed = git(['-C', root, 'diff', '--cached', '--name-only', '--diff-filter=ACM', '-z']);
  const names = listed.toString('utf8').split('\0').filter(Boolean);
  for (const name of names) {
    const blob = git(['-C', root, 'show', `:${name}`], { maxBuffer: MAX_BYTES });
    if (blob.includes(0)) continue;
    scanText(name.split(path.sep).join('/'), blob.toString('utf8'), scan);
  }
}

function parsePlusPath(line) {
  let raw = line.slice(4).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  if (raw === '/dev/null') return null;
  if (raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function scanGitHistory(scan) {
  const root = repoRoot();
  return new Promise((resolve, reject) => {
    const child = spawn('git', [
      '-C', root,
      '-c', 'core.quotepath=false',
      'log',
      '-p',
      '--all',
      '--no-color',
      '--pretty=tformat:%x1eCOMMIT %H%n%an%n%ae%n%B',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let stderr = '';
    let file = null;
    let lineNo = 0;
    let commit = '';
    let inMessage = false;
    let messageLine = 0;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

    const handle = (line) => {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith('\x1eCOMMIT ')) {
        commit = line.slice('\x1eCOMMIT '.length).trim();
        inMessage = true;
        messageLine = 0;
        file = null;
        lineNo = 0;
        return;
      }
      if (line.startsWith('diff --git ')) {
        inMessage = false;
        file = null;
        lineNo = 0;
        return;
      }
      if (inMessage) {
        messageLine += 1;
        scan.consider(`commit-message/${commit}`, messageLine, line);
        return;
      }
      if (line.startsWith('+++ ')) {
        file = parsePlusPath(line);
        lineNo = 0;
        return;
      }
      if (line.startsWith('--- ') || line.startsWith('index ') || line.startsWith('new file ')
        || line.startsWith('deleted file ') || line.startsWith('similarity ')
        || line.startsWith('rename ') || line.startsWith('old mode ')
        || line.startsWith('new mode ') || line.startsWith('Binary files ')) {
        return;
      }
      const found = hunk.exec(line);
      if (found) {
        lineNo = Number(found[1]) - 1;
        return;
      }
      if (line.startsWith('+')) {
        lineNo += 1;
        if (file) scan.consider(file, lineNo, line.slice(1));
        return;
      }
      if (line.startsWith('-') || line.startsWith('\\')) return;
      if (file) lineNo += 1;
    };

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk) => {
      buf += decoder.write(chunk);
      let splitAt = buf.indexOf('\n');
      while (splitAt !== -1) {
        handle(buf.slice(0, splitAt));
        buf = buf.slice(splitAt + 1);
        splitAt = buf.indexOf('\n');
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      buf += decoder.end();
      if (buf.length > 0) handle(buf);
      if (code !== 0) {
        reject(new Error(`git log failed (${code}): ${stderr.trim().slice(0, 300)}`));
        return;
      }
      resolve();
    });
  });
}

function warnUnset() {
  process.stderr.write(
    'sensitive-hash: WARNING: SENSITIVE_SALT or SENSITIVE_HASHES is unset, so repo-specific sensitive strings were NOT checked. Set both (HMAC-SHA256 via scripts/security/hash-sensitive.mjs). Pass --require to fail closed.\n',
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (opts.staged && (opts.gitHistory || opts.paths.length > 0)) {
    fail('--staged scans the index only; do not pass paths or --git-history.');
  }
  if (opts.gitHistory && opts.paths.length > 0) {
    fail('--git-history scans the repository history only; do not pass paths.');
  }

  const config = loadConfig(process.env);
  if (config.invalid.length > 0) {
    fail(`SENSITIVE_HASHES has ${config.invalid.length} value(s) that are not 64-character hex. Refusing to scan.`);
  }
  if (!config.configured) {
    warnUnset();
    if (opts.require) fail('--require is set and the check is not configured.');
    return;
  }

  const scan = createScan(config.salt, new Set(config.hashes));
  if (opts.staged) scanStaged(scan);
  else if (opts.gitHistory) await scanGitHistory(scan);
  else scanPaths(opts.paths.length > 0 ? opts.paths : ['.'], scan);

  if (scan.hits.length > 0) {
    process.stdout.write(`${scan.hits.join('\n')}\n`);
    process.stderr.write(`sensitive-hash: ${scan.hits.length} hit(s)\n`);
    process.exit(1);
  }
  process.stderr.write('sensitive-hash: no hits\n');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

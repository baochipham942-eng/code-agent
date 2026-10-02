#!/usr/bin/env node
// Print HMAC-SHA256(SENSITIVE_SALT, normalized argument) as lowercase hex.
// The salt stays in the environment. The argument is one candidate the
// scanner would emit (one token, email, IPv4, hostname, or CJK window).
// Stdout is only the hex. A spaced phrase is hashed whole and a stderr
// note says the scanner will not look that phrase up as a single candidate.

import { extractCandidates, hmacSha256Hex, normalizeCandidate } from './sensitive-hash-lib.mjs';

function fail(message) {
  process.stderr.write(`sensitive-hash: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  process.stderr.write('Usage: SENSITIVE_SALT=... node scripts/security/hash-sensitive.mjs "<string>"\n');
  process.exit(0);
}
if (args.length !== 1) {
  fail('pass exactly one string. Quote values that contain spaces.');
}

const salt = (process.env.SENSITIVE_SALT ?? '').trim();
if (!salt) fail('SENSITIVE_SALT is required. The HMAC key is never taken from the argument.');

const normalized = normalizeCandidate(args[0]);
if (!normalized) fail('refusing to hash an empty string.');

if (!extractCandidates(args[0]).has(normalized)) {
  process.stderr.write(
    'sensitive-hash: note: this HMAC is of the whole normalized argument. The scanner matches split tokens, emails, IPv4 addresses, hostnames, and CJK windows of 2-4 characters. Hash each of those pieces separately when the argument contains whitespace or punctuation.\n',
  );
}

process.stdout.write(`${hmacSha256Hex(salt, normalized)}\n`);

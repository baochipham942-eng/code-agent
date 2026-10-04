// Shared by the sensitive-string gate and the offline hasher.
// HMAC-SHA256(salt, normalized candidate). Plain SHA-256 is not used:
// short names are brute-forceable without a salt.
//
// Normalization is NFC, trim, then toLowerCase(). The scanner emits:
//   - tokens split on whitespace and Unicode punctuation, normalized
//   - email addresses
//   - IPv4 addresses
//   - hostnames (dotted labels, letter TLD)
//   - CJK runs as sliding windows of 2, 3, and 4 code points
// A spaced phrase is not itself a candidate; each piece is.

import { createHmac } from 'node:crypto';

export const HASH_PREFIX_LEN = 12;

const EMAIL_SOURCE = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_SOURCE = `(?<!\\d)${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}(?!\\d)`;
const HOST_SOURCE = '\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}\\b';
const CJK_SOURCE = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]+';

export function normalizeCandidate(value) {
  return String(value).normalize('NFC').trim().toLowerCase();
}

export function hmacSha256Hex(salt, normalized) {
  return createHmac('sha256', salt).update(normalized, 'utf8').digest('hex');
}

function collect(re, text, into, group = 0) {
  const pattern = new RegExp(re.source, re.flags);
  for (const match of text.matchAll(pattern)) {
    const raw = match[group];
    if (raw) into.add(normalizeCandidate(raw));
  }
}

export function extractCandidates(text) {
  const found = new Set();
  if (!text) return found;

  collect(new RegExp(EMAIL_SOURCE, 'gi'), text, found);
  collect(new RegExp(IPV4_SOURCE, 'g'), text, found);
  collect(new RegExp(HOST_SOURCE, 'gi'), text, found);

  const cjk = new RegExp(CJK_SOURCE, 'gu');
  for (const match of text.matchAll(cjk)) {
    const chars = [...match[0]];
    const max = Math.min(4, chars.length);
    for (let size = 2; size <= max; size += 1) {
      for (let index = 0; index + size <= chars.length; index += 1) {
        found.add(normalizeCandidate(chars.slice(index, index + size).join('')));
      }
    }
  }

  for (const token of text.split(/[\s\p{P}]+/u)) {
    const normalized = normalizeCandidate(token);
    if (normalized) found.add(normalized);
  }
  return found;
}

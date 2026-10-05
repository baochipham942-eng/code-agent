#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ANCHOR_RE = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)#L(\d+)(?:-L(\d+))?/g;
const BANNED_PHRASES = ['已加密', '已审核', '已脱敏', '已验证', 'guaranteed', 'safe'];

function parseTableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  const parts = trimmed.split('|');
  const start = parts[0] === '' ? 1 : 0;
  const end = parts.at(-1) === '' ? parts.length - 1 : parts.length;
  return parts.slice(start, end).map((cell) => cell.trim());
}

function tableRows(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith('|')) {
      if (current) tables.push(current);
      current = null;
      continue;
    }
    const cells = parseTableCells(line);
    if (cells.length === 0) continue;
    if (!current) current = { header: cells, headerLine: index + 1, rows: [] };
    else if (!/^\|?\s*:?-{3,}/.test(line) && !cells.every((cell) => /^:?-{3,}:?$/.test(cell))) current.rows.push({ cells, line: index + 1 });
  }
  if (current) tables.push(current);
  return tables;
}

/**
 * Validate docs/NOTICE.md anchors and table contracts.
 * `exists(file)` and `lineCount(file)` are injected by tests so no filesystem
 * assumptions are hidden in the contract.
 */
export function checkNotice(text, { exists = () => true, lineCount = () => Number.POSITIVE_INFINITY } = {}) {
  const errors = [];
  const warnings = [];
  const anchors = [...text.matchAll(ANCHOR_RE)];
  const anchorFiles = new Set();

  for (const match of anchors) {
    const [, file, startRaw, endRaw] = match;
    const start = Number(startRaw);
    const end = Number(endRaw ?? startRaw);
    anchorFiles.add(file);
    if (!exists(file)) {
      errors.push(`missing anchored file: ${file}`);
      continue;
    }
    const count = lineCount(file);
    if (start > count || end > count) {
      warnings.push(`anchor beyond EOF: ${file}#L${start}${endRaw ? `-L${end}` : ''} (file has ${count} lines)`);
    }
  }

  for (const phrase of BANNED_PHRASES) {
    const present = /^[a-z]+$/.test(phrase)
      ? new RegExp(`\\b${phrase}\\b`, 'i').test(text)
      : text.includes(phrase);
    if (present) errors.push(`banned phrase: ${phrase}`);
  }

  for (const table of tableRows(text)) {
    const isOutbound = table.header.some((cell) => cell === '请求')
      || table.header.some((cell) => cell.includes('出网执行点'));
    for (const row of table.rows) {
      const rowText = row.cells.join(' | ');
      if (!ANCHOR_RE.test(rowText)) errors.push(`table row ${row.line} has no anchor`);
      ANCHOR_RE.lastIndex = 0;
      if (isOutbound) {
        const lastCell = row.cells.at(-1) ?? '';
        if (lastCell !== '待 ADR-066') errors.push(`Table B row ${row.line} last cell must be 待 ADR-066`);
      }
    }
  }

  if (anchors.length === 0) errors.push('no file anchors found');
  return { ok: errors.length === 0, errors, warnings, anchorFiles: [...anchorFiles] };
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '../..');
  const noticePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repoRoot, 'docs/NOTICE.md');
  const fileRoot = process.argv[3] ? path.resolve(process.argv[3]) : repoRoot;
  const text = fs.readFileSync(noticePath, 'utf8');
  const result = checkNotice(text, {
    exists: (file) => fs.existsSync(path.join(fileRoot, file)),
    lineCount: (file) => fs.readFileSync(path.join(fileRoot, file), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/).length,
  });
  for (const warning of result.warnings) console.warn(`WARN ${warning}`);
  for (const error of result.errors) console.error(`FAIL ${error}`);
  if (result.ok) console.log(`[notice-anchors] PASS (${result.anchorFiles.length} files)`);
  else process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();

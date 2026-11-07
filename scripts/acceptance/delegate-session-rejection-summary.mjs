#!/usr/bin/env node
// ADR-072 E6（flag 内测期打点）：汇总 host 日志里的 delegate_session 结局行。
//
// 用法：node scripts/acceptance/delegate-session-rejection-summary.mjs <logfile...>
//
// 数据源是 logger 写出的 JSON 行（src/host/services/infra/logger.ts writeToFile），
// 其中 message === '[DelegateSession] outcome'、data[0] = { outcome, code, gate, action }。
// 纯 node、零依赖；这是报告，永远 exit 0。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUTCOME_MESSAGE = '[DelegateSession] outcome';
const E6_MIN_TOTAL = 500;
const E6_MIN_DISTINCT_CODES = 2;

export function parseOutcomeLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let row;
  try {
    row = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!row || typeof row !== 'object' || row.message !== OUTCOME_MESSAGE) return null;
  const props = Array.isArray(row.data) ? row.data[0] : row.data;
  if (!props || typeof props !== 'object') return null;
  const { outcome, code, gate, action } = props;
  if (typeof outcome !== 'string' || typeof code !== 'string') return null;
  return {
    outcome,
    code,
    gate: typeof gate === 'string' ? gate : 'none',
    action: typeof action === 'string' ? action : 'unknown',
  };
}

export function summarizeDelegateSessionOutcomes(logTexts) {
  const codeGate = new Map();
  const rejectedCodes = new Set();
  let total = 0;
  let ok = 0;
  let rejected = 0;
  for (const text of logTexts) {
    for (const line of String(text).split('\n')) {
      const parsed = parseOutcomeLine(line);
      if (!parsed) continue;
      total += 1;
      if (parsed.outcome === 'ok') ok += 1;
      if (parsed.outcome === 'rejected') {
        rejected += 1;
        rejectedCodes.add(parsed.code);
      }
      const key = `${parsed.code}\t${parsed.gate}`;
      codeGate.set(key, (codeGate.get(key) ?? 0) + 1);
    }
  }
  const distinctCodes = rejectedCodes.size;
  const missing = [];
  if (total < E6_MIN_TOTAL) missing.push(`total ${total} < ${E6_MIN_TOTAL}`);
  if (rejected <= 0) missing.push('no rejections recorded');
  if (distinctCodes < E6_MIN_DISTINCT_CODES) missing.push(`distinct rejection codes ${distinctCodes} < ${E6_MIN_DISTINCT_CODES}`);
  return {
    total,
    ok,
    rejected,
    distinctCodes,
    codeGate: Object.fromEntries([...codeGate.entries()].map(([key, count]) => {
      const [code, gate] = key.split('\t');
      return [key, { code, gate, count }];
    })),
    verdict: missing.length === 0 ? 'PASS' : 'PENDING',
    missing,
  };
}

export function formatDelegateSessionSummary(report) {
  const lines = [];
  lines.push(`total calls: ${report.total}`);
  lines.push(`ok: ${report.ok}`);
  lines.push(`rejected: ${report.rejected}`);
  lines.push('code x gate:');
  const entries = Object.values(report.codeGate).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code) || a.gate.localeCompare(b.gate));
  if (entries.length === 0) lines.push('  (no outcome lines found)');
  for (const { code, gate, count } of entries) {
    lines.push(`  ${code} × ${gate}: ${count}`);
  }
  lines.push(`distinct rejection codes: ${report.distinctCodes}`);
  lines.push(report.verdict === 'PASS' ? 'E6: PASS' : `E6: PENDING (${report.missing.join('; ')})`);
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node scripts/acceptance/delegate-session-rejection-summary.mjs <logfile...>');
  } else {
    const texts = files.map((file) => readFileSync(file, 'utf8'));
    console.log(formatDelegateSessionSummary(summarizeDelegateSessionOutcomes(texts)));
  }
  process.exit(0);
}

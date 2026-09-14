#!/usr/bin/env node
// core 集周跑收尾：比对上一轮报告、生成五行摘要，落 ~/.ship/feedback-inbox/eval-core/<日期>.md 并打到 stdout。
// 用法：node scripts/eval-core-summary.mjs --report <本轮 json> [--prev <上轮 json>] --exit <code> [--out <md>]
import fs from 'node:fs';
import path from 'node:path';
import { buildCoreSummary } from './lib/eval-core-summary.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const reportPath = opt('--report');
if (!reportPath) { console.error('缺 --report <json>'); process.exit(1); }
const prevPath = opt('--prev');
const exitCode = Number(opt('--exit') ?? '0');
const current = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const previous = prevPath && fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, 'utf8')) : undefined;
const summary = buildCoreSummary({ current, previous, exitCode, reportPath });
const out = opt('--out');
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `# core 集周跑 ${new Date().toISOString().slice(0, 10)}\n\n${summary}\n${prevPath ? `\n上一轮：${prevPath}\n` : ''}`);
}
console.log(summary);

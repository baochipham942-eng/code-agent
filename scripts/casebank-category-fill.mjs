#!/usr/bin/env node
// N-EVAL-CASEBANK-CATEGORY-FILL：把题库 category 补齐到契约 TestCategory 四值（src/host/testing/types.ts）。
//   node scripts/casebank-category-fill.mjs --dry-run   打印「文件 / 题 id / 现值 / 拟填值 / 依据」全表
//   node scripts/casebank-category-fill.mjs --write     落盘
// 写回是逐行改写（只动 category 行与 tags），不经 YAML 序列化，注释与格式原样保留；
// 落盘前重新解析并逐题比对：除 category/tags 外任何字段变了就拒写。
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

const CASE_BANK = '.claude/test-cases';
// 与 caseBank.ts ENUMERATED_SUBDIRECTORIES 对齐的四个专项目录（drafts 不补：草稿走编辑器写入）
const SUBDIRS = ['artifact-runnable', 'goal-contract', 'memory', 'user-simulator'];
const CONTRACT = ['basic_tool', 'task_completion', 'error_recovery', 'edge_case'];

// 非契约现值 → 契约值；原值补进 case tags，不丢信息
const VALUE_MAP = {
  formula: 'task_completion',
  macro: 'task_completion',
  transpose: 'task_completion',
  text_parsing: 'task_completion',
  conditional_formatting: 'task_completion',
  tool_discovery: 'task_completion',
  git_workflow: 'task_completion',
  multiagent: 'task_completion',
  security: 'edge_case',
  error_handling: 'error_recovery',
};

const FILE_DEFAULT = [
  [/^01-tool/, 'basic_tool'],
  [/^(04-error-handling|07-recovery)/, 'error_recovery'],
  [/^(06-security|14-edge-case)/, 'edge_case'],
];

// 人工判定（证据档「人工判定清单」逐条有理由）：规则给的值与题目语义不符时在这里改
const MANUAL = {
  'read-file-not-exists': ['error_recovery', 'type=error_handling，考的是读不存在文件后的处理，不是工具基本调用'],
  'web-fetch-invalid-url': ['error_recovery', 'type=error_handling，考的是无效 URL 失败后的处理'],
  'conv-refuse-dangerous': ['edge_case', '危险请求拒绝，与 06 红线题同轴'],
};

const TAG_WORDS = { error: 'error_recovery', errors: 'error_recovery', recovery: 'error_recovery', edge: 'edge_case', boundary: 'edge_case', redline: 'edge_case' };

function tagCorrection(tags) {
  for (const tag of tags) {
    for (const word of String(tag).split(/[-_:]/)) {
      if (TAG_WORDS[word]) return [TAG_WORDS[word], `tag「${tag}」`];
    }
  }
  return null;
}

function decide(file, testCase, suiteTags) {
  const current = testCase.category;
  if (current !== undefined && CONTRACT.includes(current)) return { value: current, basis: '已是契约值' };
  if (MANUAL[testCase.id]) return { value: MANUAL[testCase.id][0], basis: `人工：${MANUAL[testCase.id][1]}`, manual: true };
  if (current !== undefined) {
    if (!VALUE_MAP[current]) return { value: null, basis: `未知非契约值 ${current}` };
    return { value: VALUE_MAP[current], basis: `映射 ${current}→${VALUE_MAP[current]}`, addTag: current };
  }
  const tagged = tagCorrection([...(testCase.tags ?? []), ...(suiteTags ?? [])]);
  if (tagged) return { value: tagged[0], basis: `${tagged[1]}修正` };
  const base = path.basename(file);
  const hit = FILE_DEFAULT.find(([re]) => re.test(base));
  if (hit) return { value: hit[1], basis: `文件 ${base.split('-').slice(0, 2).join('-')}` };
  return { value: 'task_completion', basis: '文件默认（其余）', fallback: true };
}

function caseFiles() {
  const files = fs.readdirSync(CASE_BANK).filter((f) => f.endsWith('.yaml')).map((f) => path.join(CASE_BANK, f));
  for (const dir of SUBDIRS) {
    const abs = path.join(CASE_BANK, dir);
    if (!fs.existsSync(abs)) continue;
    files.push(...fs.readdirSync(abs).filter((f) => f.endsWith('.yaml')).map((f) => path.join(abs, f)));
  }
  return files.sort();
}

// 找 `  - id: X` 所在块：到下一个同缩进 `- ` 或更浅的非空非注释行为止
function caseBlock(lines, id) {
  const start = lines.findIndex((line) => new RegExp(`^(\\s*)- id: ['"]?${id}['"]?\\s*(#.*)?$`).test(line));
  if (start < 0) throw new Error(`找不到题 ${id}`);
  const dashIndent = lines[start].indexOf('-');
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    const line = lines[end];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < dashIndent || (indent === dashIndent && line.trimStart().startsWith('- '))) break;
  }
  return { start, end, keyIndent: ' '.repeat(dashIndent + 2) };
}

function editCase(lines, id, value, addTag) {
  const { start, end, keyIndent } = caseBlock(lines, id);
  const keyLine = (key) => {
    for (let i = start + 1; i < end; i += 1) if (lines[i].startsWith(`${keyIndent}${key}:`)) return i;
    return -1;
  };
  const categoryLine = keyLine('category');
  if (categoryLine >= 0) {
    lines[categoryLine] = lines[categoryLine].replace(/category:\s*\S+/, `category: ${value}`);
  } else {
    const anchor = keyLine('type');
    lines.splice(anchor >= 0 ? anchor + 1 : start + 1, 0, `${keyIndent}category: ${value}`);
  }
  if (!addTag) return;
  const { end: newEnd } = caseBlock(lines, id);
  let tagsLine = -1;
  for (let i = start + 1; i < newEnd; i += 1) if (lines[i].startsWith(`${keyIndent}tags:`)) tagsLine = i;
  if (tagsLine < 0) {
    lines.splice(keyLine('category') + 1, 0, `${keyIndent}tags: [${addTag}]`);
    return;
  }
  const flow = lines[tagsLine].match(/^(\s*tags:\s*\[)(.*)\](\s*(#.*)?)$/);
  if (flow) {
    lines[tagsLine] = `${flow[1]}${flow[2].trim() ? `${flow[2].trim()}, ` : ''}${addTag}]${flow[3]}`;
    return;
  }
  let last = tagsLine;
  while (last + 1 < newEnd && /^\s*- /.test(lines[last + 1])) last += 1;
  const itemIndent = last > tagsLine ? lines[last].match(/^\s*/)[0] : `${keyIndent}  `;
  lines.splice(last + 1, 0, `${itemIndent}- ${addTag}`);
}

function verifyRewrite(file, before, after, decisions) {
  const a = yaml.load(before);
  const b = yaml.load(after);
  const strip = (tc) => ({ ...tc, category: undefined, tags: undefined });
  if (JSON.stringify({ ...a, cases: undefined }) !== JSON.stringify({ ...b, cases: undefined })) throw new Error(`${file}: 套件级字段被改动`);
  if (a.cases.length !== b.cases.length) throw new Error(`${file}: 题数变化`);
  a.cases.forEach((tc, i) => {
    const next = b.cases[i];
    const d = decisions.get(tc.id);
    const expectedTags = d.addTag ? [...new Set([...(tc.tags ?? []), d.addTag])] : tc.tags;
    if (JSON.stringify(strip(tc)) !== JSON.stringify(strip(next))) throw new Error(`${file}/${tc.id}: category/tags 之外的字段被改动`);
    if (next.category !== d.value) throw new Error(`${file}/${tc.id}: category 应为 ${d.value}，实为 ${next.category}`);
    if (JSON.stringify(next.tags) !== JSON.stringify(expectedTags)) throw new Error(`${file}/${tc.id}: tags 不符 ${JSON.stringify(next.tags)}`);
  });
}

const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--dry-run') ? 'dry-run' : null;
if (!mode) {
  console.error('用法: node scripts/casebank-category-fill.mjs --dry-run | --write');
  process.exit(2);
}

const rows = [];
const before = new Map();
const after = new Map();
for (const file of caseFiles()) {
  const text = fs.readFileSync(file, 'utf8');
  const suite = yaml.load(text);
  const decisions = new Map();
  const lines = text.split('\n');
  for (const testCase of suite.cases ?? []) {
    const d = decide(file, testCase, suite.tags);
    decisions.set(testCase.id, d);
    before.set(testCase.category ?? '(未填)', (before.get(testCase.category ?? '(未填)') ?? 0) + 1);
    after.set(d.value ?? '(未填)', (after.get(d.value ?? '(未填)') ?? 0) + 1);
    rows.push({ file: path.relative(CASE_BANK, file), id: testCase.id, current: testCase.category ?? '', ...d });
    if (d.value && (d.value !== testCase.category || d.addTag)) editCase(lines, testCase.id, d.value, d.addTag);
  }
  const next = lines.join('\n');
  verifyRewrite(file, text, next, decisions);
  if (mode === 'write' && next !== text) fs.writeFileSync(file, next);
}

console.log('| 文件 | 题 id | 现值 | 拟填值 | 依据 |');
console.log('|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.file} | ${r.id} | ${r.current || '—'} | ${r.value ?? '(未填)'} | ${r.basis}${r.addTag ? `；tags+${r.addTag}` : ''} |`);
const changed = rows.filter((r) => r.value !== (r.current || undefined) || r.addTag).length;
const fmt = (m) => [...m].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(' / ');
console.log(`\n总题数 ${rows.length}；改动 ${changed}；未决 ${rows.filter((r) => !r.value).length}；人工 ${rows.filter((r) => r.manual).length}；文件默认（其余）${rows.filter((r) => r.fallback).length}`);
console.log(`前：${fmt(before)}`);
console.log(`后：${fmt(after)}`);
if (rows.some((r) => !r.value)) process.exit(1);

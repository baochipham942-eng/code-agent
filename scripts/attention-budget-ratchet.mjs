#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const knownArgs = new Set(['--repo-root', '--baseline', '--panorama']);
const unknown = args.filter((arg, index) => arg.startsWith('--')
  ? !knownArgs.has(arg)
  : index === 0 || !knownArgs.has(args[index - 1]));
if (unknown.length > 0) {
  console.error(`[attention-budget-ratchet] ✗ 不支持的参数：${unknown.join(', ')}`);
  process.exit(1);
}

const repoRoot = path.resolve(option('--repo-root', path.resolve(scriptDir, '..')));
const baselinePath = path.resolve(repoRoot, option('--baseline', 'scripts/attention-budget-ratchet-baseline.json'));
const panoramaPath = path.resolve(repoRoot, option('--panorama', 'docs/architecture/injection-panorama.md'));
const hostRoot = path.join(repoRoot, 'src/host');

function failSelfCheck(message) {
  console.error(`[attention-budget-ratchet] ✗ 自检失败：${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    failSelfCheck(`无法读取 ${path.relative(repoRoot, file)}：${error instanceof Error ? error.message : String(error)}`);
  }
}

const baseline = readJson(baselinePath);
if (baseline.schemaVersion !== 1
  || !Number.isFinite(baseline.globalFixedTokens)
  || !Number.isFinite(baseline.liveVoiceFixedTokens)
  || !Number.isFinite(baseline.liveVoiceToleranceRatio)
  || !Number.isInteger(baseline.panoramaMatchedFiles)
  || !Number.isInteger(baseline.astCallCount)
  || !Number.isInteger(baseline.panoramaPointCount)
  || typeof baseline.reason !== 'string' || !baseline.reason.trim()) {
  failSelfCheck('基线格式无效，提额必须保留数值、容差、两类点位计数和非空理由');
}

let panorama;
try {
  panorama = fs.readFileSync(panoramaPath, 'utf8');
} catch (error) {
  failSelfCheck(`无法读取全景表：${error instanceof Error ? error.message : String(error)}`);
}

const declaredCount = panorama.match(/rg -l 'injectSystemMessage\|system_reminder' src\/host` 当前命中 (\d+) 个文件/)?.[1];
if (!declaredCount) failSelfCheck('全景表缺少 rg 文件数声明，无法判断表是否陈旧');
if (Number(declaredCount) !== baseline.panoramaMatchedFiles) {
  failSelfCheck(`基线声明 ${baseline.panoramaMatchedFiles} 个命中文件，全景表声明 ${declaredCount} 个，请先对账`);
}

function sourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(file));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) out.push(file);
  }
  return out;
}

const matchedFiles = sourceFiles(hostRoot).filter((file) => /injectSystemMessage|system_reminder/.test(fs.readFileSync(file, 'utf8')));
if (matchedFiles.length === 0) failSelfCheck('扫描命中 0 个文件，禁止测量路径失效时假绿');
if (matchedFiles.length !== Number(declaredCount)) {
  failSelfCheck(`全景表声明 ${declaredCount} 个命中文件，实际扫描 ${matchedFiles.length} 个；先更新全景表再过门`);
}

function pointOf(file, sourceFile, node) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `${path.relative(repoRoot, file).split(path.sep).join('/')}:${line}`;
}

function isInjectionCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const expression = node.expression;
  return (ts.isIdentifier(expression) && expression.text === 'injectSystemMessage')
    || (ts.isPropertyAccessExpression(expression) && expression.name.text === 'injectSystemMessage');
}

function isGuarded(node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) {
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)
      || ts.isSwitchStatement(current) || ts.isCaseClause(current)
      || ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)
      || ts.isWhileStatement(current) || ts.isDoStatement(current)
      || (ts.isBinaryExpression(current)
        && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
          .includes(current.operatorToken.kind))) return true;
    current = current.parent;
  }
  return false;
}

function staticText(node) {
  if (!node) return '';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => span.literal.text).join('');
  }
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return staticText(node.left) + staticText(node.right);
  }
  return '';
}

const calls = [];
for (const file of matchedFiles) {
  const sourceText = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (isInjectionCall(node)) {
      calls.push({
        point: pointOf(file, sourceFile, node),
        guarded: isGuarded(node),
        staticText: staticText(node.arguments[0]),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

// —— 计数棘轮（行号漂移免疫）：全景表的逐点行号仅供人读；机器只对账两类计数，
// 增删注入点会改变计数而单纯挪行号不会，避免 20 个热点文件的无关改动把门打红。
const panoramaPoints = [...panorama.matchAll(/`(src\/host\/[^`:]+\.(?:ts|tsx|js|mjs)):(\d+)[^`]*`/g)].length;
if (panoramaPoints !== baseline.panoramaPointCount) {
  failSelfCheck(`全景表点位数 ${panoramaPoints} ≠ 基线 ${baseline.panoramaPointCount}；增删注入点后先更新全景表，再同步基线并写理由`);
}

// 预算回归本体：全局无条件固定开销直接从 AST 求和（无守卫 + 静态文案），量代码不量文档。
// 转发/门面调用的实参是变量，staticText 为空，自然不计入，无需行号豁免清单。
const unguardedStatic = calls.filter((call) => !call.guarded && call.staticText);
let globalTokens = 0;
for (const call of unguardedStatic) globalTokens += Math.round(call.staticText.length / 3);

function voiceStaticText() {
  const file = path.join(hostRoot, 'agent/orchestratorTurnContext.ts');
  if (!fs.existsSync(file)) return '';
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let result = '';
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'join' && ts.isArrayLiteralExpression(node.expression.expression)) {
      const parts = node.expression.expression.elements.map(staticText);
      if (parts.some((part) => part.includes('live_voice_permission_notice'))) result = parts.join('\n');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

const voiceText = voiceStaticText();
if (!voiceText) failSelfCheck('未找到 live_voice_permission_notice 固定文案，语音预算已失去测量能力');
const voiceTokens = Math.round(voiceText.length / 3);
const voiceMin = baseline.liveVoiceFixedTokens * (1 - baseline.liveVoiceToleranceRatio);
const voiceMax = baseline.liveVoiceFixedTokens * (1 + baseline.liveVoiceToleranceRatio);

console.log(`[attention-budget-ratchet] 扫描 ${matchedFiles.length} 个命中文件、${calls.length} 个 injectSystemMessage 调用`);
console.log(`[attention-budget-ratchet] 本地无守卫静态注入总量 current=${globalTokens} baseline=${baseline.globalFixedTokens}`);
console.log(`[attention-budget-ratchet] 实时语音条件路径 current=${voiceTokens} baseline=${baseline.liveVoiceFixedTokens} tolerance=±${Math.round(baseline.liveVoiceToleranceRatio * 100)}%`);

let failed = false;
if (calls.length !== baseline.astCallCount) {
  failed = true;
  console.error(`[attention-budget-ratchet] ✗ injectSystemMessage 调用数 current=${calls.length} baseline=${baseline.astCallCount}——增删注入点必须同步全景表与基线（rg -n injectSystemMessage src/host 定位差异）。`);
}
if (unguardedStatic.length > 0 && globalTokens > baseline.globalFixedTokens) {
  console.error(`[attention-budget-ratchet] ✗ 发现 ${unguardedStatic.length} 个无条件静态注入调用点：`);
  for (const call of unguardedStatic) {
    console.error(`  ${call.point} static=${Math.round(call.staticText.length / 3)} token`);
  }
}
if (globalTokens > baseline.globalFixedTokens) {
  failed = true;
  console.error(`[attention-budget-ratchet] ✗ 本地无守卫静态注入总量超基线 +${globalTokens - baseline.globalFixedTokens} token。把新增调用改成条件触发或降频；确属产品有意提额时，在基线文件显式提额并写理由（attention-budget-ratchet-baseline.json）。`);
}
if (voiceTokens < voiceMin || voiceTokens > voiceMax) {
  failed = true;
  console.error(`[attention-budget-ratchet] ✗ 实时语音固定开销 ${voiceTokens} token/轮超出允许区间 ${voiceMin.toFixed(1)}–${voiceMax.toFixed(1)}。收窄文案，或在基线文件显式提额并写理由。`);
}
if (failed) process.exit(1);
console.log('[attention-budget-ratchet] ✓ 注入点计数、无守卫静态总量与语音固定开销均未超基线');

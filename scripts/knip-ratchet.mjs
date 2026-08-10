#!/usr/bin/env node
// ============================================================================
// knip-ratchet — dead-export 棘轮门（集合基线）
// ============================================================================
//
// 跑 knip 收集 unused exports + types。profile 决定入口/范围与独立基线；基线记录每个
// 文件、符号名和类别；当前结果中不在基线的符号即阻塞。这样同一批清理存量
// 死导出时，不能再用净计数下降掩盖新造的死导出。
//
// 2026-08-07 本地与 CI 的总数曾相差一处。集合基线必须以 CI 首次点名的额外
// 符号补齐，不能用“允许 N 个未知新增”的宽容度掩盖环境差异。
// knip 版本锁 6.24.0；升版本须先重测并有意更新基线。
//
// 用法：
//   node scripts/knip-ratchet.mjs
//   node scripts/knip-ratchet.mjs --update-baseline
//   node scripts/knip-ratchet.mjs --profile production
//   node scripts/knip-ratchet.mjs --profile production --update-baseline

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const KNIP_VERSION = '6.24.0';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const profiles = {
  default: {
    baselineFile: 'knip-ratchet-baseline.json',
    configFile: null,
    label: 'dead-export',
  },
  production: {
    baselineFile: 'knip-production-export-ratchet-baseline.json',
    configFile: 'knip.production-strict.json',
    label: 'production dead-export',
    tracksUnreachableFiles: true,
  },
};

const args = process.argv.slice(2);
const updateBaseline = args.includes('--update-baseline');
const profileIndex = args.indexOf('--profile');
const profileName = profileIndex === -1 ? 'default' : args[profileIndex + 1];
const consumedArgumentIndexes = new Set([...(updateBaseline ? [args.indexOf('--update-baseline')] : []), ...(profileIndex === -1 ? [] : [profileIndex, profileIndex + 1])]);
const unknownArguments = args.filter((_, index) => !consumedArgumentIndexes.has(index));
const profile = profiles[profileName];

if (!profile || unknownArguments.length > 0) {
  const detail = !profile ? `未知 profile：${profileName}` : `不支持的参数：${unknownArguments.join(', ')}`;
  console.error(`[knip-ratchet] ✗ ${detail}；仅支持 --update-baseline 和 --profile production`);
  process.exit(1);
}

const baselinePath = path.join(scriptDir, profile.baselineFile);

function compareSymbols(a, b) {
  return a.file.localeCompare(b.file) || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind);
}

function symbolKey(symbol) {
  return `${symbol.file}\u0000${symbol.kind}\u0000${symbol.name}`;
}

function formatSymbol(symbol) {
  return `${symbol.file}: ${symbol.name} (${symbol.kind})`;
}

function collectSymbols(report) {
  const symbols = [];
  for (const issue of report.issues) {
    for (const entry of issue.exports ?? []) symbols.push({ file: issue.file, name: entry.name, kind: 'export' });
    for (const entry of issue.types ?? []) symbols.push({ file: issue.file, name: entry.name, kind: 'type' });
  }
  return symbols.sort(compareSymbols);
}

function collectUnreachableFiles(report) {
  const files = new Set();
  for (const issue of report.issues) {
    if (typeof issue.file === 'string') files.add(issue.file);
    for (const entry of issue.files ?? []) {
      if (typeof entry.name === 'string') files.add(entry.name);
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

function readBaseline() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    console.error(`[knip-ratchet] ✗ 自检失败：无法读取基线 ${path.relative(process.cwd(), baselinePath)}：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const validSymbols = Array.isArray(parsed.symbols)
    && !parsed.symbols.some((symbol) => !symbol || typeof symbol.file !== 'string' || typeof symbol.name !== 'string'
      || !['export', 'type'].includes(symbol.kind));
  const validUnreachableFiles = !profile.tracksUnreachableFiles
    || (Array.isArray(parsed.unreachableFiles) && parsed.unreachableFiles.every((file) => typeof file === 'string'));
  const expectedSchemaVersion = profile.tracksUnreachableFiles ? 2 : 1;
  if (parsed.schemaVersion !== expectedSchemaVersion || !validSymbols || !validUnreachableFiles) {
    const expected = profile.tracksUnreachableFiles
      ? 'schemaVersion=2、有序 symbols[] 和有序 unreachableFiles[]'
      : 'schemaVersion=1 和有序 symbols[]';
    console.error(`[knip-ratchet] ✗ 自检失败：基线格式无效，预期 ${expected}`);
    process.exit(1);
  }
  return {
    symbols: parsed.symbols.sort(compareSymbols),
    unreachableFiles: profile.tracksUnreachableFiles ? [...parsed.unreachableFiles].sort((a, b) => a.localeCompare(b)) : [],
  };
}

function runKnip(include) {
  const result = spawnSync(
  'npx',
  ['--yes', `knip@${KNIP_VERSION}`, ...(profile.configFile ? ['--config', profile.configFile] : []), '--include', include, '--no-progress', '--reporter', 'json'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );

  // knip 有 issue 时 exit 1 属正常；以 JSON 可解析为准判断门本身是否健康（自检 fail loud）。
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error(`[knip-ratchet] ✗ 自检失败：knip ${include} 输出不可解析（工具未装好/配置损坏/被 kill）`);
    console.error(result.stderr?.slice(0, 2000) || '(无 stderr)');
    process.exit(1);
  }
  if (!Array.isArray(report.issues)) {
    console.error(`[knip-ratchet] ✗ 自检失败：knip ${include} JSON 里没有 issues 数组，报告格式变了，请同步更新本脚本`);
    process.exit(1);
  }
  return report;
}

function exportedNames(sourceText, fileName) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  const names = new Set();
  const addBindingNames = (name) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addBindingNames(element.name);
      }
    }
  };
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBindingNames(declaration.name);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement) || ts.isEnumDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
    }
  }
  return names;
}

function baselineRevision() {
  const configured = process.env.KNIP_RATCHET_BASE_REF;
  const candidates = configured ? [configured] : ['origin/main', 'main'];
  for (const candidate of candidates) {
    const result = spawnSync('git', ['merge-base', 'HEAD', candidate], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  console.error('[knip-ratchet] ✗ 自检失败：无法解析比较基点；设置 KNIP_RATCHET_BASE_REF 或确保 origin/main/main 可用');
  process.exit(1);
}

function historicalExportNames(file, revision) {
  const result = spawnSync('git', ['show', `${revision}:${file}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return new Set();
  return exportedNames(result.stdout, file);
}

const report = runKnip('exports,types');
const currentSymbols = collectSymbols(report);
const fileReport = profile.tracksUnreachableFiles ? runKnip('files') : null;
const currentUnreachableFiles = fileReport ? collectUnreachableFiles(fileReport) : [];
if (updateBaseline) {
  const baseline = profile.tracksUnreachableFiles
    ? { schemaVersion: 2, symbols: currentSymbols, unreachableFiles: currentUnreachableFiles }
    : { schemaVersion: 1, symbols: currentSymbols };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`[knip-ratchet] ${profile.label} 扫描完成：${report.issues.length} 个命中文件，${currentSymbols.length} 个 dead export/type 符号`);
  if (profile.tracksUnreachableFiles) {
    console.log(`[knip-ratchet] 生产不可达文件：${currentUnreachableFiles.length} 个，已写入第二维基线`);
  }
  console.log(`[knip-ratchet] ✓ 已更新 ${path.relative(process.cwd(), baselinePath)}；CI 首跑若点名环境额外符号，核实后将其补入此集合`);
  process.exit(0);
}

const baseline = readBaseline();
const baselineSymbols = baseline.symbols;
const baselineKeys = new Set(baselineSymbols.map(symbolKey));
const currentKeys = new Set(currentSymbols.map(symbolKey));
const added = currentSymbols.filter((symbol) => !baselineKeys.has(symbolKey(symbol)));
const removed = baselineSymbols.filter((symbol) => !currentKeys.has(symbolKey(symbol)));
const baselineUnreachableFiles = new Set(baseline.unreachableFiles);
const currentUnreachableFileSet = new Set(currentUnreachableFiles);
const revivedFiles = new Set(baseline.unreachableFiles.filter((file) => !currentUnreachableFileSet.has(file)));
const disconnectedFiles = currentUnreachableFiles.filter((file) => !baselineUnreachableFiles.has(file));
const historicalNamesByRevivedFile = new Map();
if (revivedFiles.size > 0) {
  const revision = baselineRevision();
  for (const file of revivedFiles) historicalNamesByRevivedFile.set(file, historicalExportNames(file, revision));
}
const newlyIntroduced = added.filter((symbol) => {
  if (!revivedFiles.has(symbol.file)) return true;
  return !historicalNamesByRevivedFile.get(symbol.file)?.has(symbol.name);
});
const newlyIntroducedKeys = new Set(newlyIntroduced.map(symbolKey));
const surfacedStoredSymbols = added.filter((symbol) => !newlyIntroducedKeys.has(symbolKey(symbol)));

console.log(`[knip-ratchet] ${profile.label} 扫描完成：${report.issues.length} 个命中文件；当前 ${currentSymbols.length} 个符号，基线 ${baselineSymbols.length} 个符号`);
if (profile.tracksUnreachableFiles) {
  console.log(`[knip-ratchet] 生产不可达文件：当前 ${currentUnreachableFiles.length} 个，基线 ${baseline.unreachableFiles.length} 个`);
}

if (disconnectedFiles.length > 0) {
  console.error(`[knip-ratchet] ✗ 发现 ${disconnectedFiles.length} 个生产文件从可达变为不可达，不能把断电当作存量清理：`);
  for (const file of disconnectedFiles) console.error(`  ${file}`);
}

if (newlyIntroduced.length > 0) {
  console.error(`[knip-ratchet] ✗ 发现 ${newlyIntroduced.length} 个新增 dead export/type，不能由存量清理抵消：`);
  for (const symbol of newlyIntroduced) console.error(`  ${formatSymbol(symbol)}`);
}

if (disconnectedFiles.length > 0 || newlyIntroduced.length > 0) {
  process.exit(1);
}

if (surfacedStoredSymbols.length > 0) {
  console.log(`[knip-ratchet] ✓ ${surfacedStoredSymbols.length} 个符号随不可达文件复活而现形，均已存在于比较基点，未计为新增：`);
  for (const symbol of surfacedStoredSymbols) console.log(`  ${formatSymbol(symbol)}`);
}

if (removed.length > 0) {
  console.log(`[knip-ratchet] ✓ 未新增；有 ${removed.length} 个存量符号已清理，可运行 --update-baseline 从基线移除：`);
  for (const symbol of removed) console.log(`  ${formatSymbol(symbol)}`);
} else {
  console.log('[knip-ratchet] ✓ 未新增；当前符号集合与基线一致');
}

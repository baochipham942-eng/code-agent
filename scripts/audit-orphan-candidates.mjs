#!/usr/bin/env node
/* global console, process */
// ============================================================================
// audit-orphan-candidates — 孤儿能力（建好没接电）候选清单生成器（只读审计）
// ============================================================================
//
// 为什么需要这个脚本：
//   knip 生产 profile 的两份基线已经记录了"从发行入口走不到的文件 / 没有生产消费方的
//   导出"，但 3489 个符号没法逐个人工判读。本脚本把基线蒸馏成三层候选，供
//   docs/audits/ 的孤儿接线审计逐行判读（wire / delete / replaced-elsewhere）：
//
//   T1 = 生产文件基线（knip-production-ratchet-baseline.json 的 files[]）里的每个文件。
//   T2 = src/renderer 下"零 importer"的 .tsx 组件（对 src/ 与 tests/ 全量做 grep 式
//        importer 计数；生产 importer 与仅测试 importer 分开列出）。
//   T3 = 导出基线（knip-production-export-ratchet-baseline.json 的 symbols[]）里
//        src/renderer 下 kind=export（忽略 type）的符号，按文件分组；≥3 个符号的文件
//        进入判读名单，其余标记 deferred 只给计数。
//
//   src/host/extension/**（ExtensionRegistry，已有冻结工单 N-EXTREGISTRY-WIRE）一律剔除。
//
// 只读：本脚本不跑 knip、不改基线、不改 src/，只读两份基线 JSON 与源码文本。
//
// importer 计数的口径：扫描 src/** 与 tests/** 的 .ts/.tsx/.mjs/.js 文本，用正则抽取
// `from '…'` / `import '…'` / `import('…')` / `require('…')` 说明符，按 tsconfig paths
// 别名（@renderer/@shared/@host/@internal-evaluation/@）+ 相对路径 + 扩展名顺序解析到
// 仓库相对路径。与逐文件跑
//   grep -rn "from '\(\.\|\.\.\)/<name>'" src tests
// 等价，但一次扫描即得全量索引；动态 import（React.lazy）同样计入。
//
// 用法：
//   node scripts/audit-orphan-candidates.mjs                     # markdown 清单打到 stdout
//   node scripts/audit-orphan-candidates.mjs --json out.json     # 额外落一份机器可读 JSON
//   node scripts/audit-orphan-candidates.mjs \
//     --exports-baseline <path>                                  # 喂临时基线（反向变异验证用）
//
// 退出码：0 正常；1 参数或基线格式错误。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
export const FILES_BASELINE_PATH = join(REPO_ROOT, 'scripts/knip-production-ratchet-baseline.json');
export const EXPORTS_BASELINE_PATH = join(REPO_ROOT, 'scripts/knip-production-export-ratchet-baseline.json');
export const KNIP_CONFIG_PATHS = ['knip.json', 'knip.production.json'];
export const EXTENSION_EXCLUSION = 'src/host/extension/';

// tsconfig.json paths 的别名前缀（长前缀优先）。值必须是仓库相对目录。
export const ALIASES = [
  ['@internal-evaluation-scripts/', 'packages/internal/evaluation-center/scripts/'],
  ['@internal-evaluation/', 'packages/internal/evaluation-center/src/'],
  ['@renderer/', 'src/renderer/'],
  ['@shared/', 'src/shared/'],
  ['@host/', 'src/host/'],
  ['@/', 'src/'],
];

// 说明符解析到文件时的扩展名尝试顺序（与 bundler moduleResolution 一致）。
export const EXTENSION_SUFFIXES = ['.ts', '.tsx', '.mjs', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.mjs'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js']);

function fail(message) {
  throw new Error(`[audit-orphan-candidates] ✗ 自检失败：${message}`);
}

// ---------------------------------------------------------------------------
// 纯函数：import 说明符抽取与解析
// ---------------------------------------------------------------------------

// 抽取一个模块文本里全部 import/require 说明符（相对路径与别名路径；裸包名返回原样，
// 由 resolveSpecifier 判 null）。等价于 grep -o "from '…'" 系列的并集。
export function collectImportSpecifiers(content) {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

// 把说明符解析成仓库相对路径（无扩展名）；裸包名（react、node:fs 等）返回 null。
export function resolveSpecifier(spec, importerFile) {
  for (const [alias, target] of ALIASES) {
    if (spec.startsWith(alias)) {
      return normalizePath(target + spec.slice(alias.length));
    }
  }
  if (spec.startsWith('.')) {
    return normalizePath(join(dirname(importerFile), spec));
  }
  return null;
}

// 说明符（已解析为无扩展名路径）可能对应的实际文件候选，按解析顺序排列。
export function candidateSpecPaths(resolved) {
  return [resolved, ...EXTENSION_SUFFIXES.map((suffix) => resolved + suffix)];
}

function normalizePath(p) {
  return normalize(p).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// 纯函数：importer 索引
// ---------------------------------------------------------------------------

// files: [{ path: 'src/…' | 'tests/…', specifiers: string[] }]
// 返回 { targetFile -> { production: importer[], test: importer[] } }。
// 自己 import 自己不算 importer；口径与 knip 一致：tests/**、src 内 __tests__/** 与
// *.test.* / *.spec.* 都算测试 importer——co-located 测试正是"有测试没接电"的伪装色。
// exists 由调用方注入（生产走文件系统，测试走夹具集合），保持函数纯度可测。
export function isTestLikePath(path) {
  return path.startsWith('tests/') || /(^|\/)__tests__\//.test(path)
    || /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

export function buildImporterIndexWithExists(files, exists) {
  const knownFiles = new Set(files.map((file) => file.path));
  const index = new Map();
  for (const { path, specifiers } of files) {
    for (const spec of specifiers) {
      const resolved = resolveSpecifier(spec, path);
      if (!resolved) continue;
      const target = candidateSpecPaths(resolved).find((candidate) => knownFiles.has(candidate) || exists(candidate));
      if (!target) continue;
      const entry = index.get(target) ?? { production: [], test: [] };
      if (path === target) continue;
      (isTestLikePath(path) ? entry.test : entry.production).push(path);
      index.set(target, entry);
    }
  }
  for (const entry of index.values()) {
    entry.production = [...new Set(entry.production)].sort();
    entry.test = [...new Set(entry.test)].sort();
  }
  return index;
}

// ---------------------------------------------------------------------------
// 纯函数：三层候选
// ---------------------------------------------------------------------------

export function tierT1(filesBaselineFiles) {
  return filesBaselineFiles
    .filter((file) => !file.startsWith(EXTENSION_EXCLUSION))
    .sort();
}

export function tierT2(rendererTsxFiles, importerIndex, entryFiles) {
  const entries = new Set(entryFiles);
  return rendererTsxFiles
    .filter((file) => !file.startsWith(EXTENSION_EXCLUSION))
    .filter((file) => !entries.has(file))
    .map((file) => ({ file, importers: importerIndex.get(file) ?? { production: [], test: [] } }))
    .filter(({ importers }) => importers.production.length === 0 && importers.test.length === 0)
    .map(({ file }) => file)
    .sort();
}

export function tierT3(exportSymbols) {
  const groups = new Map();
  for (const symbol of exportSymbols) {
    if (symbol.kind !== 'export') continue;
    if (!symbol.file.startsWith('src/renderer/')) continue;
    if (symbol.file.startsWith(EXTENSION_EXCLUSION)) continue;
    const list = groups.get(symbol.file) ?? [];
    list.push(symbol.name);
    groups.set(symbol.file, list);
  }
  const judged = [];
  const deferred = [];
  for (const [file, symbols] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sortedSymbols = [...symbols].sort();
    if (sortedSymbols.length >= 3) {
      judged.push({ file, symbols: sortedSymbols });
    } else {
      deferred.push({ file, count: sortedSymbols.length });
    }
  }
  return { judged, deferred };
}

// ---------------------------------------------------------------------------
// 带副作用的部分：读盘扫描
// ---------------------------------------------------------------------------

function walkSourceFiles(rootDir) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (SOURCE_EXTENSIONS.has(extensionOf(entry.name))) {
        out.push(full);
      }
    }
  };
  visit(rootDir);
  return out.map((full) => normalizePath(full.slice(REPO_ROOT.length + 1)));
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

export function scanImporterFiles(scanRoots = ['src', 'tests']) {
  const files = [];
  for (const root of scanRoots) {
    for (const path of walkSourceFiles(join(REPO_ROOT, root))) {
      const content = readFileSync(join(REPO_ROOT, path), 'utf8');
      files.push({ path, specifiers: collectImportSpecifiers(content) });
    }
  }
  return files;
}

export function readJson(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

export function entryFilesFromConfigs(configPaths = KNIP_CONFIG_PATHS) {
  const entries = new Set();
  for (const configPath of configPaths) {
    const config = readJson(join(REPO_ROOT, configPath));
    if (!Array.isArray(config.entry)) fail(`${configPath} 缺 entry 数组。`);
    for (const entry of config.entry) {
      if (!entry.includes('*') && SOURCE_EXTENSIONS.has(extensionOf(entry))) entries.add(normalizePath(entry));
    }
  }
  return [...entries].sort();
}

export function parseArgs(argv) {
  const args = { filesBaseline: FILES_BASELINE_PATH, exportsBaseline: EXPORTS_BASELINE_PATH, jsonOut: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--json' && next) {
      args.jsonOut = next;
      i += 1;
    } else if (arg === '--files-baseline' && next) {
      args.filesBaseline = next;
      i += 1;
    } else if (arg === '--exports-baseline' && next) {
      args.exportsBaseline = next;
      i += 1;
    } else {
      fail(`不支持的参数：${arg}；仅支持 --json <path>、--files-baseline <path>、--exports-baseline <path>。`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// 组装与输出
// ---------------------------------------------------------------------------

export function buildAudit({ filesBaselineFiles, exportSymbols, rendererTsxFiles, importerIndex, entryFiles }) {
  const t1 = tierT1(filesBaselineFiles);
  const t2 = tierT2(rendererTsxFiles, importerIndex, entryFiles);
  const t3 = tierT3(exportSymbols);
  const result = {
    summary: {
      t1Files: t1.length,
      t2Files: t2.length,
      t3JudgedFiles: t3.judged.length,
      t3JudgedSymbols: t3.judged.reduce((sum, group) => sum + group.symbols.length, 0),
      t3DeferredFiles: t3.deferred.length,
      t3DeferredSymbols: t3.deferred.reduce((sum, group) => sum + group.count, 0),
    },
    tiers: {
      t1: t1.map((file) => ({ file, importers: importerIndex.get(file) ?? { production: [], test: [] } })),
      t2,
      t3,
    },
  };
  return result;
}

export function renderMarkdown(audit) {
  const lines = [];
  lines.push('# 孤儿能力候选清单（audit-orphan-candidates）');
  lines.push('');
  lines.push(`- T1（生产不可达文件基线）：${audit.summary.t1Files} 个`);
  lines.push(`- T2（src/renderer 零 importer 的 .tsx）：${audit.summary.t2Files} 个`);
  lines.push(`- T3（renderer 无生产消费方的 export，按文件分组）：判读 ${audit.summary.t3JudgedFiles} 文件 / ${audit.summary.t3JudgedSymbols} 符号；deferred ${audit.summary.t3DeferredFiles} 文件 / ${audit.summary.t3DeferredSymbols} 符号`);
  lines.push('');
  lines.push('## T1 生产不可达文件（含 importer 计数）');
  lines.push('');
  lines.push('| 文件 | 生产 importer | 仅测试 importer |');
  lines.push('|---|---|---|');
  for (const row of audit.tiers.t1) {
    lines.push(`| ${row.file} | ${row.importers.production.length} | ${row.importers.test.length} |`);
  }
  lines.push('');
  lines.push('## T2 零 importer 的 renderer .tsx');
  lines.push('');
  for (const file of audit.tiers.t2) {
    lines.push(`- ${file}`);
  }
  lines.push('');
  lines.push('## T3 判读名单（≥3 个候选 export 符号的文件）');
  lines.push('');
  for (const group of audit.tiers.t3.judged) {
    lines.push(`- ${group.file}（${group.symbols.length}）：${group.symbols.join(', ')}`);
  }
  lines.push('');
  lines.push('## T3 deferred（<3 个候选符号，只记计数）');
  lines.push('');
  for (const group of audit.tiers.t3.deferred) {
    lines.push(`- ${group.file}：${group.count}`);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const filesBaseline = readJson(args.filesBaseline);
  const exportsBaseline = readJson(args.exportsBaseline);
  if (filesBaseline.schemaVersion !== 1 || !Array.isArray(filesBaseline.files)) {
    fail(`${args.filesBaseline} 不是 schemaVersion=1 的文件基线。`);
  }
  if (exportsBaseline.schemaVersion !== 2 || !Array.isArray(exportsBaseline.symbols)) {
    fail(`${args.exportsBaseline} 不是 schemaVersion=2 的导出基线。`);
  }
  const scanFiles = scanImporterFiles();
  const importerIndex = buildImporterIndexWithExists(scanFiles, (candidate) => false);
  const rendererTsxFiles = scanFiles
    .filter(({ path }) => path.startsWith('src/renderer/') && path.endsWith('.tsx'))
    .map(({ path }) => path)
    .sort();
  const entryFiles = entryFilesFromConfigs();
  const audit = buildAudit({
    filesBaselineFiles: filesBaseline.files,
    exportSymbols: exportsBaseline.symbols,
    rendererTsxFiles,
    importerIndex,
    entryFiles,
  });
  const markdown = renderMarkdown(audit);
  if (args.jsonOut) {
    writeFileSync(args.jsonOut, `${JSON.stringify(audit, null, 2)}\n`);
    console.log(`JSON 已写入 ${args.jsonOut}`);
  }
  console.log(markdown);
}

main();

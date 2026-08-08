#!/usr/bin/env node
// ============================================================================
// host-chinese-error-ratchet — host 用户文案 error 字面量棘轮
// ============================================================================
//
// P2 扫描口径（2026-08-08，基于 origin/main 2498aa02b 实测）：
//   - 扫描 src/host/tools/**/*.{ts,tsx} 与 src/host/memory/**/*.{ts,tsx}。
//   - 排除 __tests__、*.test.*、*.spec.*、*.d.ts；这些不是发行版 host 实现。
//   - 用 TypeScript parser 找对象属性名为 error / 'error' / ['error'] 的
//     PropertyAssignment；只要它的 initializer 子树含至少一个汉字字符串片段，就计 1 个目标。
//   - 字符串、无插值模板串、带插值模板串，以及 `upstreamError || '中文兜底'` 这类
//     组合表达式都覆盖。一个 error 属性即使含多个中文片段仍只计 1，避免改写句子拆分方式
//     造成无业务意义的计数抖动。
//
// 误报边界：initializer 内嵌的回调、对象或函数调用参数若含中文，也会归到外层 error；
// 这是有意偏保守，新增时应人工确认该中文是否真的不会进入 error。
// 漏报边界：间接引用常量（error: SOME_MESSAGE）、变量赋值、throw new Error(...)、运行时
// 拼出的中文，以及 src/host 其他目录不在本门口径内。P2 只锁事实源点名的 tools + memory
// `error:` 字面量，不把它扩成 P3 长尾迁移或全 host 文案治理。
//
// Fail loud：扫描 0 文件、0 目标、任一文件解析失败、根路径配置失效或 TypeScript parser
// 无法加载都会非零退出。清理低于基线时必须同步下调 BASELINE_MAX；只能降，不能升。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');

export const SCAN_ROOTS = ['src/host/tools', 'src/host/memory'];
export const BASELINE_MAX = 152;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isExcluded(filePath) {
  const posix = toPosix(filePath);
  const name = path.basename(filePath);
  return (
    posix.includes('/__tests__/') ||
    /\.(?:test|spec)\.(?:ts|tsx)$/.test(name) ||
    name.endsWith('.d.ts')
  );
}

function collectFiles(root, files) {
  if (!fs.existsSync(root)) {
    throw new Error(`扫描根不存在：${root}`);
  }
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) {
    throw new Error(`扫描根不是目录：${root}`);
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      collectFiles(fullPath, files);
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
      !isExcluded(fullPath)
    ) {
      files.add(fullPath);
    }
  }
}

function staticPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

function expressionContainsHanLiteral(expression) {
  let matched = false;
  const visit = (node) => {
    if (matched) return;
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      HAN_RE.test(node.text)
    ) {
      matched = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return matched;
}

function formatParseDiagnostic(diagnostic, sourceFile) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (typeof diagnostic.start !== 'number') return message;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  return `${line + 1}:${character + 1} ${message}`;
}

export function scanHostChineseErrorLiterals(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const roots = options.roots ?? SCAN_ROOTS;
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((root) => typeof root !== 'string' || root.trim() === '')) {
    throw new Error('扫描根配置为空或格式无效');
  }

  const files = new Set();
  for (const root of roots) {
    collectFiles(path.resolve(rootDir, root), files);
  }
  const sortedFiles = [...files].sort();
  if (sortedFiles.length === 0) {
    throw new Error(`扫描 0 个源文件：${roots.join(', ')}`);
  }

  const findings = [];
  for (const file of sortedFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
    if (parseDiagnostics.length > 0) {
      const details = parseDiagnostics
        .slice(0, 5)
        .map((diagnostic) => formatParseDiagnostic(diagnostic, sourceFile))
        .join('\n  ');
      throw new Error(`TypeScript 解析失败：${toPosix(path.relative(rootDir, file))}\n  ${details}`);
    }

    const visit = (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        staticPropertyName(node.name) === 'error' &&
        expressionContainsHanLiteral(node.initializer)
      ) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        findings.push({
          file: toPosix(path.relative(rootDir, file)),
          line: line + 1,
          column: character + 1,
          preview: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 180),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  if (findings.length === 0) {
    throw new Error(`扫描 ${sortedFiles.length} 个源文件但命中 0 个中文 error 字面量；扫描器或口径可能已失效`);
  }

  return {
    roots: [...roots],
    fileCount: sortedFiles.length,
    targetCount: findings.length,
    findings,
  };
}

export function assertHostChineseErrorBaseline(report, baseline = BASELINE_MAX) {
  if (!Number.isInteger(baseline) || baseline < 0) {
    throw new Error(`基线配置无效：${String(baseline)}`);
  }
  if (report.targetCount > baseline) {
    const sample = report.findings
      .slice(0, 30)
      .map((finding) => `  ${finding.file}:${finding.line}:${finding.column}\t${finding.preview}`)
      .join('\n');
    throw new Error(
      `中文 error 字面量超基线 ${report.targetCount - baseline} 个（current=${report.targetCount}, baseline=${baseline}）\n` +
      `新增命中必须改为稳定 code + renderer i18n；前 30 个命中：\n${sample}`,
    );
  }
}

function runCli() {
  try {
    const report = scanHostChineseErrorLiterals();
    console.log(`[host-chinese-error-ratchet] 扫描 ${report.fileCount} 个 host 源文件`);
    console.log(`[host-chinese-error-ratchet] 中文 error 字面量 current=${report.targetCount} baseline=${BASELINE_MAX}`);
    assertHostChineseErrorBaseline(report);
    if (report.targetCount < BASELINE_MAX) {
      console.log(`[host-chinese-error-ratchet] ✓ 低于基线 ${BASELINE_MAX - report.targetCount} 个；请把 BASELINE_MAX 下调到 ${report.targetCount}`);
    } else {
      console.log('[host-chinese-error-ratchet] ✓ 等于基线，通过（未新增）');
    }
  } catch (error) {
    console.error(`[host-chinese-error-ratchet] ✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runCli();
}

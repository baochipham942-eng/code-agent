#!/usr/bin/env node
// ============================================================================
// shared-host-boundary — shared / renderer 不得依赖 src/host
// ============================================================================
// no-restricted-imports 看不见动态 import()。本门用 TypeScript AST 扫描
// src/shared 与 src/renderer 的非测试 .ts/.tsx：ImportDeclaration、
// 带 moduleSpecifier 的 ExportDeclaration、import()、require()、import() 类型节点。
// 相对路径按文件解析；别名 @host/* 与 @/host/* 同样算进 src/host。
// 扫描 0 个文件或解析失败直接失败，避免目录改名后门禁静默恒绿。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '../..');
const SCAN_ROOTS = ['src/shared', 'src/renderer'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isExcluded(filePath) {
  const posix = toPosix(filePath);
  const name = path.basename(filePath);
  return posix.includes('/__tests__/') || /\.(?:test|spec)\.(?:ts|tsx)$/.test(name) || name.endsWith('.d.ts');
}

function collectFiles(root, files) {
  if (!fs.existsSync(root)) throw new Error(`扫描根不存在：${toPosix(root)}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`扫描根不是目录：${toPosix(root)}`);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') collectFiles(fullPath, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !isExcluded(fullPath)) {
      files.add(fullPath);
    }
  }
}

function locationOf(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function specifierText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function isInside(parent, target) {
  const rel = path.relative(parent, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolvesToHost(specifier, fromFile, rootDir) {
  if (typeof specifier !== 'string' || specifier === '') return false;
  const hostRoot = path.resolve(rootDir, 'src/host');
  if (specifier === '@host' || specifier.startsWith('@host/')) {
    const rest = specifier === '@host' ? '' : specifier.slice('@host/'.length);
    return isInside(hostRoot, path.resolve(hostRoot, rest));
  }
  if (specifier === '@/host' || specifier.startsWith('@/host/')) {
    const rest = specifier === '@/host' ? '' : specifier.slice('@/host/'.length);
    return isInside(hostRoot, path.resolve(hostRoot, rest));
  }
  if (!specifier.startsWith('.')) return false;
  return isInside(hostRoot, path.resolve(path.dirname(fromFile), specifier));
}

function violationOf(node, sourceFile, file, rootDir) {
  let kind = null;
  let rawSpecifier = null;
  if (ts.isImportDeclaration(node)) {
    kind = 'import';
    rawSpecifier = specifierText(node.moduleSpecifier);
  } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    kind = 'export-from';
    rawSpecifier = specifierText(node.moduleSpecifier);
  } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    kind = 'import()';
    rawSpecifier = specifierText(node.arguments[0]);
  } else if (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require'
  ) {
    kind = 'require()';
    rawSpecifier = specifierText(node.arguments[0]);
  } else if (ts.isImportTypeNode(node)) {
    kind = 'import-type';
    const arg = node.argument;
    if (ts.isLiteralTypeNode(arg)) rawSpecifier = specifierText(arg.literal);
    else rawSpecifier = specifierText(arg);
  }
  if (!kind || !rawSpecifier || !resolvesToHost(rawSpecifier, file, rootDir)) return null;
  const { line, column } = locationOf(sourceFile, node);
  return {
    file: toPosix(path.relative(rootDir, file)),
    line,
    column,
    kind,
    specifier: rawSpecifier,
  };
}

export function scan(rootDir) {
  if (typeof rootDir !== 'string' || rootDir.trim() === '') {
    throw new Error('扫描根目录无效');
  }
  const root = path.resolve(rootDir);
  const files = new Set();
  for (const rel of SCAN_ROOTS) {
    collectFiles(path.join(root, rel), files);
  }
  const sortedFiles = [...files].sort();
  if (sortedFiles.length === 0) {
    throw new Error(`扫描 0 个目标源文件：${SCAN_ROOTS.join(', ')}`);
  }

  const violations = [];
  for (const file of sortedFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    if ((sourceFile.parseDiagnostics ?? []).length > 0) {
      throw new Error(`TypeScript 解析失败：${toPosix(path.relative(root, file))}`);
    }
    const visit = (node) => {
      const violation = violationOf(node, sourceFile, file, root);
      if (violation) violations.push(violation);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  violations.sort((a, b) => (
    a.file.localeCompare(b.file)
    || a.line - b.line
    || a.column - b.column
    || a.kind.localeCompare(b.kind)
    || a.specifier.localeCompare(b.specifier)
  ));
  return { fileCount: sortedFiles.length, violations };
}

function runCli() {
  try {
    const report = scan(repoRoot);
    console.log(`[shared-host-boundary] 扫描 ${report.fileCount} 个目标源文件，违规 ${report.violations.length} 处`);
    if (report.violations.length > 0) {
      const details = report.violations
        .map((violation) => `  ${violation.file}:${violation.line}:${violation.column} ${violation.kind} ${violation.specifier}`)
        .join('\n');
      throw new Error(`发现 ${report.violations.length} 处 shared/renderer → host 依赖：\n${details}`);
    }
    console.log('[shared-host-boundary] ✓ 通过');
  } catch (error) {
    console.error(`[shared-host-boundary] ✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) runCli();

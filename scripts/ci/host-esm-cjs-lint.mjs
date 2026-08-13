#!/usr/bin/env node
// ============================================================================
// host-esm-cjs-lint — host 工具 / 插件的 ESM/CJS 边界静态门
// ============================================================================
// 扫描 src/host/tools、src/host/plugins 与工具会直接进入的 design service 发行源码。裸 require(...)、__dirname
// 和 module.exports 会在 ESM bundle 的惰性执行路径上延迟爆炸；CJS 依赖必须改为静态
// import，或在 ESM 生成脚本中显式 createRequire。扫描 0 个源码文件、根路径失效、TS
// 解析失败均直接失败，避免目录改名后门禁静默恒绿。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '../..');

export const SCAN_ROOTS = ['src/host/tools', 'src/host/plugins', 'src/host/services/design'];
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
  if (!fs.existsSync(root)) throw new Error(`扫描根不存在：${root}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`扫描根不是目录：${root}`);
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

export function scanHostEsmCjsPrimitives(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const roots = options.roots ?? SCAN_ROOTS;
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((root) => typeof root !== 'string' || root.trim() === '')) {
    throw new Error('扫描根配置为空或格式无效');
  }

  const files = new Set();
  for (const root of roots) collectFiles(path.resolve(rootDir, root), files);
  const sortedFiles = [...files].sort();
  if (sortedFiles.length === 0) throw new Error(`扫描 0 个目标源文件：${roots.join(', ')}`);

  const findings = [];
  for (const file of sortedFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if ((sourceFile.parseDiagnostics ?? []).length > 0) {
      throw new Error(`TypeScript 解析失败：${toPosix(path.relative(rootDir, file))}`);
    }

    const visit = (node) => {
      let kind;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        kind = 'require(...)';
      } else if (ts.isIdentifier(node) && node.text === '__dirname') {
        kind = '__dirname';
      } else if (
        ts.isPropertyAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'module'
        && node.name.text === 'exports'
      ) {
        kind = 'module.exports';
      }
      if (kind) {
        const { line, column } = locationOf(sourceFile, node);
        findings.push({ file: toPosix(path.relative(rootDir, file)), line, column, kind });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { roots: [...roots], fileCount: sortedFiles.length, findings };
}

export function assertNoHostEsmCjsPrimitives(report) {
  if (!report || !Number.isInteger(report.fileCount) || report.fileCount <= 0) {
    throw new Error('扫描报告无有效目标源文件，拒绝静默通过');
  }
  if (report.findings.length > 0) {
    const details = report.findings.map((finding) => `  ${finding.file}:${finding.line}:${finding.column} ${finding.kind}`).join('\n');
    throw new Error(`发现 ${report.findings.length} 个 ESM 不安全 CJS 原语：\n${details}`);
  }
}

function runCli() {
  try {
    const report = scanHostEsmCjsPrimitives();
    console.log(`[host-esm-cjs-lint] 扫描 ${report.fileCount} 个目标源文件，裸 CJS 原语命中 ${report.findings.length} 处`);
    assertNoHostEsmCjsPrimitives(report);
    console.log('[host-esm-cjs-lint] ✓ 通过（存量 0 命中）');
  } catch (error) {
    console.error(`[host-esm-cjs-lint] ✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) runCli();

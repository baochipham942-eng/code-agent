#!/usr/bin/env npx tsx
/**
 * 发版证据登记表一致性门（fail-closed）。
 *
 * 判据是**反向的**：不是「登记表里的都还在」（那只在删除时报红），而是
 * 「仓里所有写 docs/{perf,stability,evidence}/*.json 的脚本都在登记表里」。
 * 只有反向判据才抓得到「新增了第四个证据门却没人同步清单」——那是这套硬编码
 * 唯一注定会复发的失效方式。
 *
 * 门自己的盲区也要报红（#1047 教训：glob 写错时主断言给出完美假绿）：
 * - 扫描范围一个文件都没匹配到 → 报红，不是通过。
 * - 登记表里每一条都必须被扫描器从它自己的 producer 里**重新发现**一次。
 *   long-session 的路径是 OUT_DIR + 文件名两段拼的，按完整字面量扫扫不到它；
 *   这条自检就是钉死「扫描器还认得拼接形态」。
 *
 * 用法：
 *   npm run check:release-evidence-registry            # 检查
 *   npm run check:release-evidence-registry -- --write # 按登记表重写 workflow 的 paths 块
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EVIDENCE_SCAN,
  GENERATED_PATHS_BEGIN,
  GENERATED_PATHS_END,
  NON_RELEASE_EVIDENCE_OUTPUTS,
  RELEASE_EVIDENCE_GATE_WORKFLOW,
  RELEASE_EVIDENCE_PRODUCERS,
  RELEASE_WORKFLOW,
  registeredEvidencePaths,
  releaseEvidenceGatePaths,
} from '../lib/releaseEvidenceRegistry.ts';

/** 登记表与本扫描器自身：它们引用证据路径是为了记账，不是产出 */
const SELF_FILES = new Set([
  'scripts/lib/releaseEvidenceRegistry.ts',
  'scripts/ci/check-release-evidence-registry.ts',
]);

const STRING_LITERAL = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\\n$]*)`/g;
const JSON_NAME = /^[\w.-]+\.json$/;

export interface EvidenceScanResult {
  /** 扫到的脚本文件（仓库相对路径），为 0 说明扫描范围本身坏了 */
  files: string[];
  /** 证据路径 → 引用它的脚本文件 */
  outputs: Map<string, string[]>;
}

function collectScriptFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // 软链不跟进：scripts/poppler、scripts/uv 之类是外部产物目录
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (EVIDENCE_SCAN.extensions as readonly string[]).includes(path.extname(entry.name))) {
        files.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  for (const scanRoot of EVIDENCE_SCAN.roots) walk(path.join(root, scanRoot));
  return files.sort();
}

function stringLiterals(source: string): string[] {
  const values: string[] = [];
  for (const match of source.matchAll(STRING_LITERAL)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) values.push(value);
  }
  return values;
}

/** 从一个文件的字面量里还原它写向哪些证据文件（含 OUT_DIR + 文件名的两段形态） */
export function evidencePathsInSource(source: string): string[] {
  const literals = stringLiterals(source).map((value) => value.replace(/^\.\//, '').replace(/\/$/, ''));
  const dirs = EVIDENCE_SCAN.evidenceDirs as readonly string[];
  const found = new Set<string>();

  for (const literal of literals) {
    const dir = dirs.find((candidate) => literal.startsWith(`${candidate}/`));
    if (dir && JSON_NAME.test(literal.slice(dir.length + 1))) found.add(literal);
  }

  // 两段构造：目录字面量 × 同文件里的 *.json 文件名字面量。
  // 宁可多报（多出来的一条登记一行就完事），也不能漏——漏掉的恰恰是最容易漏的那类。
  const dirLiterals = dirs.filter((dir) => literals.includes(dir));
  if (dirLiterals.length > 0) {
    const names = literals.filter((literal) => JSON_NAME.test(literal));
    for (const dir of dirLiterals) for (const name of names) found.add(`${dir}/${name}`);
  }

  return [...found];
}

export function scanEvidenceOutputs(root: string): EvidenceScanResult {
  const files = collectScriptFiles(root);
  const outputs = new Map<string, string[]>();
  for (const file of files) {
    if (SELF_FILES.has(file)) continue;
    for (const evidence of evidencePathsInSource(fs.readFileSync(path.join(root, file), 'utf8'))) {
      outputs.set(evidence, [...(outputs.get(evidence) ?? []), file]);
    }
  }
  return { files, outputs };
}

/** 两个方向都判：没登记的要报红，登记了却没被重新发现的也要报红 */
export function evidenceAccountingErrors(scan: EvidenceScanResult): string[] {
  const errors: string[] = [];

  if (scan.files.length === 0) {
    errors.push(
      `evidence producer scan matched no script files under ${EVIDENCE_SCAN.roots.join(', ')} — the scan scope itself is broken`,
    );
    return errors;
  }

  const registered = new Set(registeredEvidencePaths());
  for (const [evidence, files] of [...scan.outputs].sort()) {
    if (registered.has(evidence)) continue;
    errors.push(
      `unregistered release evidence output: ${evidence} (written by ${files.join(', ')}) — `
      + 'add it to RELEASE_EVIDENCE_PRODUCERS or NON_RELEASE_EVIDENCE_OUTPUTS in scripts/lib/releaseEvidenceRegistry.ts',
    );
  }

  for (const entry of [...RELEASE_EVIDENCE_PRODUCERS, ...NON_RELEASE_EVIDENCE_OUTPUTS]) {
    const files = scan.outputs.get(entry.evidence) ?? [];
    if (!files.includes(entry.producer)) {
      errors.push(
        `registered evidence ${entry.evidence} was not rediscovered in its producer ${entry.producer} — `
        + 'either the producer stopped writing it, or the reverse scan went blind',
      );
    }
  }

  return errors;
}

function renderPathsBlock(indent: string): string[] {
  return releaseEvidenceGatePaths().map((value) => `${indent}- '${value}'`);
}

interface GeneratedBlock {
  beginLine: number;
  endLine: number;
  indent: string;
  body: string[];
}

function findGeneratedBlocks(lines: string[]): GeneratedBlock[] {
  const blocks: GeneratedBlock[] = [];
  let open: { line: number; indent: string } | null = null;
  for (const [index, line] of lines.entries()) {
    if (line.includes(GENERATED_PATHS_BEGIN)) {
      open = { line: index, indent: line.slice(0, line.indexOf('#')) };
      continue;
    }
    if (line.includes(GENERATED_PATHS_END) && open) {
      blocks.push({ beginLine: open.line, endLine: index, indent: open.indent, body: lines.slice(open.line + 1, index) });
      open = null;
    }
  }
  return blocks;
}

export function workflowPathsErrors(root: string): string[] {
  const workflowPath = path.join(root, RELEASE_EVIDENCE_GATE_WORKFLOW);
  if (!fs.existsSync(workflowPath)) return [`missing workflow: ${RELEASE_EVIDENCE_GATE_WORKFLOW}`];
  const blocks = findGeneratedBlocks(fs.readFileSync(workflowPath, 'utf8').split('\n'));
  // pull_request + push 各一份；数量不对说明标记被删了或被复制了，一致性门自己就瞎了
  if (blocks.length !== 2) {
    return [`${RELEASE_EVIDENCE_GATE_WORKFLOW} must contain exactly 2 generated paths blocks, found ${blocks.length}`];
  }
  const errors: string[] = [];
  for (const block of blocks) {
    const expected = renderPathsBlock(block.indent);
    if (block.body.join('\n') !== expected.join('\n')) {
      errors.push(
        `${RELEASE_EVIDENCE_GATE_WORKFLOW}:${block.beginLine + 1} paths block drifted from the registry — expected:\n${expected.join('\n')}`,
      );
    }
  }
  return errors;
}

/** release.yml 冻结的 artifact 清单必须覆盖每一份发版证据 */
export function releaseArtifactErrors(root: string): string[] {
  const releasePath = path.join(root, RELEASE_WORKFLOW);
  if (!fs.existsSync(releasePath)) return [`missing workflow: ${RELEASE_WORKFLOW}`];
  const source = fs.readFileSync(releasePath, 'utf8');
  return RELEASE_EVIDENCE_PRODUCERS
    .filter((entry) => !source.includes(entry.evidence))
    .map((entry) => `${RELEASE_WORKFLOW} does not freeze release evidence ${entry.evidence} as an artifact`);
}

export function checkReleaseEvidenceRegistry(root: string): string[] {
  return [
    ...evidenceAccountingErrors(scanEvidenceOutputs(root)),
    ...workflowPathsErrors(root),
    ...releaseArtifactErrors(root),
  ];
}

function writeWorkflowPaths(root: string): boolean {
  const workflowPath = path.join(root, RELEASE_EVIDENCE_GATE_WORKFLOW);
  const lines = fs.readFileSync(workflowPath, 'utf8').split('\n');
  const blocks = findGeneratedBlocks(lines);
  if (blocks.length !== 2) throw new Error(`${RELEASE_EVIDENCE_GATE_WORKFLOW} must contain exactly 2 generated paths blocks`);
  let next = lines;
  for (const block of [...blocks].reverse()) {
    next = [...next.slice(0, block.beginLine + 1), ...renderPathsBlock(block.indent), ...next.slice(block.endLine)];
  }
  const updated = next.join('\n');
  if (updated === lines.join('\n')) return false;
  fs.writeFileSync(workflowPath, updated);
  return true;
}

function main(): void {
  const argv = process.argv.slice(2);
  const root = argv.includes('--root') ? path.resolve(argv[argv.indexOf('--root') + 1] ?? '') : process.cwd();
  if (argv.includes('--write')) {
    console.log(writeWorkflowPaths(root) ? `rewrote paths in ${RELEASE_EVIDENCE_GATE_WORKFLOW}` : `${RELEASE_EVIDENCE_GATE_WORKFLOW} paths already match the registry`);
  }
  const errors = checkReleaseEvidenceRegistry(root);
  if (errors.length > 0) {
    console.error('Release evidence registry gate failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Release evidence registry gate passed (${registeredEvidencePaths().length} registered outputs).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();

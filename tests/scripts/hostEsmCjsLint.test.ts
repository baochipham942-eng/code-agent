import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- 纯 JS 静态门脚本，无类型声明
import { assertNoHostEsmCjsPrimitives, scanHostEsmCjsPrimitives } from '../../scripts/host-esm-cjs-lint.mjs';

describe('host ESM/CJS 静态门', () => {
  let repoRoot: string;
  let toolsRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'host-esm-cjs-lint-'));
    toolsRoot = join(repoRoot, 'src/host/tools');
    mkdirSync(toolsRoot, { recursive: true });
  });

  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  const scan = () => scanHostEsmCjsPrimitives({ repoRoot, roots: ['src/host/tools'] });

  it('只拦运行时代码中的裸 CJS 原语，放行字符串里的 createRequire 生成脚本', () => {
    writeFileSync(join(toolsRoot, 'safe.ts'), "const generated = `const require = createRequire('file:///x'); const Pptx = require('pptxgenjs');`;\n");
    writeFileSync(join(toolsRoot, 'unsafe.ts'), "const a = require('a'); const b = __dirname; module.exports = a;\n");
    const report = scan();
    expect(report.fileCount).toBe(2);
    expect(report.findings.map((finding: { kind: string }) => finding.kind)).toEqual(['require(...)', '__dirname', 'module.exports']);
    expect(() => assertNoHostEsmCjsPrimitives(report)).toThrow(/3 个 ESM 不安全 CJS 原语/);
  });

  it('扫描 0 个目标文件时 fail loud', () => {
    expect(() => scanHostEsmCjsPrimitives({ repoRoot, roots: ['src/host/missing'] })).toThrow(/扫描根不存在/);
  });

  it('存量工具与插件源码为 0 命中', () => {
    const report = scanHostEsmCjsPrimitives();
    expect(report.fileCount).toBeGreaterThan(0);
    expect(report.findings).toEqual([]);
  });
});

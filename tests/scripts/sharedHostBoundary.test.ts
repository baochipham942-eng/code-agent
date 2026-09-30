import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
// @ts-expect-error -- 纯 JS 静态门脚本，无类型声明
import { scan } from '../../scripts/ci/shared-host-boundary.mjs';

const repoRoot = resolve(__dirname, '../..');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shared-host-boundary-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'src/shared'), { recursive: true });
  mkdirSync(join(root, 'src/renderer'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function violations(files: Record<string, string>) {
  return scan(makeRepo(files)).violations;
}

describe('shared/renderer → host 边界门', () => {
  it('静态 import 进 src/host 判红', () => {
    expect(violations({
      'src/shared/bad.ts': "import { run } from '../host/agent/sessionRecovery';\nexport const value = run;\n",
      'src/renderer/ok.ts': 'export const ok = 1;\n',
    })).toEqual([
      expect.objectContaining({
        file: 'src/shared/bad.ts',
        line: 1,
        kind: 'import',
        specifier: '../host/agent/sessionRecovery',
      }),
    ]);
  });

  it('export ... from 进 src/host 判红', () => {
    expect(violations({
      'src/shared/bad.ts': "export { run } from '../host/diagnostics/doctorRunner';\n",
      'src/renderer/ok.ts': 'export const ok = 1;\n',
    })).toEqual([
      expect.objectContaining({
        file: 'src/shared/bad.ts',
        line: 1,
        kind: 'export-from',
        specifier: '../host/diagnostics/doctorRunner',
      }),
    ]);
  });

  it('动态 import() 进 src/host 判红', () => {
    expect(violations({
      'src/renderer/panel.tsx': "export async function load() {\n  return import('../host/mcp/mcpClient');\n}\n",
      'src/shared/ok.ts': 'export const ok = 1;\n',
    })).toEqual([
      expect.objectContaining({
        file: 'src/renderer/panel.tsx',
        line: 2,
        kind: 'import()',
        specifier: '../host/mcp/mcpClient',
      }),
    ]);
  });

  it('require() 进 src/host 判红', () => {
    expect(violations({
      'src/shared/bad.ts': "const client = require('../host/mcp/mcpClient');\nexport const value = client;\n",
      'src/renderer/ok.ts': 'export const ok = 1;\n',
    })).toEqual([
      expect.objectContaining({
        file: 'src/shared/bad.ts',
        line: 1,
        kind: 'require()',
        specifier: '../host/mcp/mcpClient',
      }),
    ]);
  });

  it('@host 与 @/host 别名 import 判红', () => {
    expect(violations({
      'src/shared/alias.ts': "import { a } from '@host/agent/sessionRecovery';\nimport { b } from '@/host/diagnostics/doctorRunner';\nexport const value = { a, b };\n",
      'src/renderer/ok.tsx': 'export const ok = 1;\n',
    })).toEqual([
      expect.objectContaining({ file: 'src/shared/alias.ts', line: 1, kind: 'import', specifier: '@host/agent/sessionRecovery' }),
      expect.objectContaining({ file: 'src/shared/alias.ts', line: 2, kind: 'import', specifier: '@/host/diagnostics/doctorRunner' }),
    ]);
  });

  it('跨行动态 import() 判红', () => {
    expect(violations({
      'src/shared/commands/definitions/sessionCommands.ts': [
        'export async function loadRecovery() {',
        '  const { getSessionRecoveryService } = await import(',
        "    '../../../host/agent/sessionRecovery'",
        '  );',
        '  return getSessionRecoveryService;',
        '}',
        '',
      ].join('\n'),
      'src/renderer/ok.ts': 'export const ok = 1;\n',
    })).toEqual([
      expect.objectContaining({
        file: 'src/shared/commands/definitions/sessionCommands.ts',
        line: 2,
        kind: 'import()',
        specifier: '../../../host/agent/sessionRecovery',
      }),
    ]);
  });

  it('import() 类型节点进 src/host 判红', () => {
    expect(violations({
      'src/shared/typed.ts': "export type Recovery = import('../host/agent/sessionRecovery').Service;\n",
      'src/renderer/ok.ts': 'export const ok = 1;\n',
    })).toEqual([
      expect.objectContaining({
        file: 'src/shared/typed.ts',
        line: 1,
        kind: 'import-type',
        specifier: '../host/agent/sessionRecovery',
      }),
    ]);
  });

  it('注释和字符串里的 host 路径不判红，非 host 相对导入放行', () => {
    const report = scan(makeRepo({
      'src/shared/clean.ts': [
        '// import { run } from "../host/agent/sessionRecovery"',
        "const note = \"require('../host/mcp/mcpClient')\";",
        'const other = `import("@/host/diagnostics/doctorRunner")`;',
        "import { local } from './sibling';",
        "export type Local = import('./sibling').Local;",
        'export const value = { note, other, local };',
        '',
      ].join('\n'),
      'src/shared/sibling.ts': 'export const local = 1;\nexport type Local = number;\n',
      'src/renderer/view.tsx': [
        '// src/host/diagnostics/types.ts is the host copy; this file does not import it.',
        "export const label = 'src/host/agent/agentLoop.ts';",
        '',
      ].join('\n'),
    }));
    expect(report.fileCount).toBe(3);
    expect(report.violations).toEqual([]);
  });

  it('排除 *.test.*、*.spec.*、*.d.ts 和 __tests__', () => {
    const report = scan(makeRepo({
      'src/shared/kept.ts': 'export const ok = 1;\n',
      'src/shared/hidden.test.ts': "import { run } from '../host/agent/sessionRecovery';\nexport const value = run;\n",
      'src/shared/hidden.spec.tsx': "import { run } from '../host/agent/sessionRecovery';\nexport const value = run;\n",
      'src/shared/types.d.ts': "import type { Run } from '../host/agent/sessionRecovery';\nexport type Value = Run;\n",
      'src/shared/__tests__/hidden.ts': "import { run } from '../../host/agent/sessionRecovery';\nexport const value = run;\n",
      'src/renderer/kept.ts': 'export const ok = 1;\n',
    }));
    expect(report.fileCount).toBe(2);
    expect(report.violations).toEqual([]);
  });

  it('扫描根被改名时失败', () => {
    const root = mkdtempSync(join(tmpdir(), 'shared-host-boundary-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'src/shared'), { recursive: true });
    writeFileSync(join(root, 'src/shared/ok.ts'), 'export const ok = 1;\n');
    expect(() => scan(root)).toThrow(/扫描根不存在：/);
  });

  it('扫描 0 个目标源文件时失败', () => {
    expect(() => scan(makeRepo())).toThrow(/扫描 0 个目标源文件/);
  });

  it('真实仓库 src/shared 与 src/renderer 为 0 违规', () => {
    const report = scan(repoRoot);
    expect(report.fileCount).toBeGreaterThan(0);
    expect(report.violations).toEqual([]);
  });
});

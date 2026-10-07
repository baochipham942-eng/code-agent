import { describe, expect, it } from 'vitest';

// @ts-expect-error —— 纯 JS 审计脚本，无类型声明
import {
  buildImporterIndexWithExists,
  candidateSpecPaths,
  collectImportSpecifiers,
  isTestLikePath,
  parseArgs,
  resolveSpecifier,
  tierT1,
  tierT2,
  tierT3,
} from '../../scripts/audit-orphan-candidates.mjs';

describe('collectImportSpecifiers / resolveSpecifier', () => {
  it('抽取 from/import()/require 四种说明符并去重', () => {
    const content = [
      "import { a } from './a';",
      "import type { B } from '@shared/contract/agent';",
      "import './side-effect';",
      "const lazy = () => import('../b/c');",
      "const req = require('@renderer/x');",
      "export * from './a';",
      "const notImport = 'from \\'nope\\'';",
    ].join('\n');
    expect([...collectImportSpecifiers(content)].sort()).toEqual([
      '../b/c',
      './a',
      './side-effect',
      '@renderer/x',
      '@shared/contract/agent',
    ]);
  });

  it('相对路径按 importer 所在目录解析，别名映射到仓库相对路径，裸包名返回 null', () => {
    expect(resolveSpecifier('./x', 'src/renderer/hooks/h.ts')).toBe('src/renderer/hooks/x');
    expect(resolveSpecifier('../stores/s', 'src/renderer/hooks/h.ts')).toBe('src/renderer/stores/s');
    expect(resolveSpecifier('@renderer/stores/s', 'any/file.ts')).toBe('src/renderer/stores/s');
    expect(resolveSpecifier('@internal-evaluation/x', 'any/file.ts'))
      .toBe('packages/internal/evaluation-center/src/x');
    expect(resolveSpecifier('react', 'src/a.ts')).toBeNull();
  });

  it('扩展名解析顺序与 bundler 一致', () => {
    expect(candidateSpecPaths('src/a/b')).toEqual([
      'src/a/b',
      'src/a/b.ts',
      'src/a/b.tsx',
      'src/a/b.mjs',
      'src/a/b.js',
      'src/a/b.jsx',
      'src/a/b/index.ts',
      'src/a/b/index.tsx',
      'src/a/b/index.mjs',
    ]);
  });
});

describe('isTestLikePath / buildImporterIndexWithExists', () => {
  it('tests/**、__tests__/** 与 *.test.* 都按测试口径归类', () => {
    expect(isTestLikePath('tests/unit/a.test.ts')).toBe(true);
    expect(isTestLikePath('src/host/tools/media/ppt/__tests__/ppt-d3d4.test.mjs')).toBe(true);
    expect(isTestLikePath('src/host/services/core/service.ts')).toBe(false);
  });

  it('co-located 测试不算生产 importer；自引用不算 importer', () => {
    const files = [
      // 生产文件直接消费
      { path: 'src/renderer/App.tsx', specifiers: collectImportSpecifiers("import { X } from './widgets/X';") },
      // co-located 测试消费（src 内 __tests__）
      { path: 'src/host/tools/ppt/__tests__/x.test.mjs', specifiers: collectImportSpecifiers("import { y } from '../spacing';") },
      // 自引用形状（构造夹具，正常不会出现）
      { path: 'src/renderer/widgets/X.tsx', specifiers: collectImportSpecifiers("import { X } from './X';") },
      // 被测目标本身也在扫描集合里（生产路径里全量 src/tests 文件都在）
      { path: 'src/host/tools/ppt/spacing.ts', specifiers: [] },
    ];
    const index = buildImporterIndexWithExists(files, () => false);
    expect(index.get('src/renderer/widgets/X.tsx')).toEqual({ production: ['src/renderer/App.tsx'], test: [] });
    expect(index.get('src/host/tools/ppt/spacing.ts')).toEqual({
      production: [],
      test: ['src/host/tools/ppt/__tests__/x.test.mjs'],
    });
  });
});

describe('tierT1 / tierT2 / tierT3', () => {
  it('T1 原样透传文件基线并剔除 extension 豁免', () => {
    const baseline = ['src/host/agent/a.ts', 'src/host/extension/adapters.ts', 'src/host/agent/b.ts'];
    expect(tierT1(baseline)).toEqual(['src/host/agent/a.ts', 'src/host/agent/b.ts']);
  });

  it('T2 只留零 importer 的 renderer tsx，且排除发行入口', () => {
    const importers = new Map([
      ['src/renderer/components/Alive.tsx', { production: ['src/renderer/App.tsx'], test: [] }],
      ['src/renderer/components/TestOnly.tsx', { production: [], test: ['tests/unit/a.test.tsx'] }],
    ]);
    const rendererFiles = [
      'src/renderer/components/Alive.tsx',
      'src/renderer/components/TestOnly.tsx',
      'src/renderer/components/Dead.tsx',
      'src/renderer/index.tsx', // 入口：零 importer 是设计使然
    ];
    expect(tierT2(rendererFiles, importers, ['src/renderer/index.tsx']))
      .toEqual(['src/renderer/components/Dead.tsx']);
  });

  it('T3 只收 renderer 的 export 符号，≥3 判读、其余 deferred', () => {
    const symbols = [
      { file: 'src/renderer/hooks/a.ts', name: 'one', kind: 'export' },
      { file: 'src/renderer/hooks/a.ts', name: 'two', kind: 'export' },
      { file: 'src/renderer/hooks/b.ts', name: 'x', kind: 'type' }, // type 不算
      { file: 'src/renderer/hooks/b.ts', name: 'y', kind: 'export' },
      { file: 'src/renderer/hooks/b.ts', name: 'z', kind: 'export' },
      { file: 'src/renderer/hooks/b.ts', name: 'w', kind: 'export' },
      { file: 'src/host/services/c.ts', name: 'h', kind: 'export' }, // 非 renderer 不算
    ];
    expect(tierT3(symbols)).toEqual({
      judged: [{ file: 'src/renderer/hooks/b.ts', symbols: ['w', 'y', 'z'] }],
      deferred: [{ file: 'src/renderer/hooks/a.ts', count: 2 }],
    });
  });
});

describe('parseArgs', () => {
  it('支持 --json 与两个基线覆盖参数，缺省指向仓内基线', () => {
    const args = parseArgs(['--json', '/tmp/out.json', '--exports-baseline', '/tmp/scratch.json']);
    expect(args.jsonOut).toBe('/tmp/out.json');
    expect(args.exportsBaseline).toBe('/tmp/scratch.json');
    expect(args.filesBaseline).toContain('knip-production-ratchet-baseline.json');
  });

  it('未知参数 fail-loud', () => {
    expect(() => parseArgs(['--nonsense'])).toThrow(/不支持的参数/);
  });
});

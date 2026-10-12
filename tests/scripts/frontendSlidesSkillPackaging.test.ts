import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import policy from '../../scripts/lib/gates-fast-policy.json';
import { selectTests } from '../../scripts/lib/gates-fast-contract.mjs';

// ============================================================================
// frontend-slides 随包清单门（N-RELEASE-LEAK-FRONTEND-SLIDES）
// ============================================================================
//
// 背景：tauri.conf.json 把 `../resources/skills` 整目录打进 app bundle，而
// release-security-scan 对「非 node_modules 且路径含 /src/」的第一方文件报
// release leak——frontend-slides 的 esbuild 入口源码 scripts/src/*.mjs 曾随包
// 出货，直接炸掉 Dev 槽构建的发版扫描。入口源已搬到 resources/skill-sources/
// （不映射进 bundle），打包树只剩运行期文件。
//
// 这道门把「打包树里不许再有 /src/」钉在本地与 PR CI，防止入口源被顺手挪回去。
// scan 规则本身不许放宽（release-security-scan.mjs 不在本单改动面里）。
// ============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillDir = path.join(repoRoot, 'resources', 'skills', 'frontend-slides');
const scanScript = path.join(repoRoot, 'scripts', 'release-security-scan.mjs');

const WRAPPERS = [
  'merge-to-pdf.mjs',
  'merge-to-pptx.mjs',
  'merge-to-pptx-hybrid.mjs',
] as const;

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const sourcesDir = path.join(repoRoot, 'resources', 'skill-sources', 'frontend-slides');
const thisTest = 'tests/scripts/frontendSlidesSkillPackaging.test.ts';

describe('frontend-slides 打包配置（resource 清单 / bundler / lint 接线）', () => {
  // 上一组 describe 钉的是「随包树本身」；这一组钉的是产生随包树的配置面——
  // tauri 打包映射、bundler 的入口/产物路径、lint 对生成物/手写源的接线，
  // 以及 gates:fast 对这些路径的路由注册（返修轮 2026-10-10：ship gate 以
  // 「unregistered PR paths need --regressions」拒了 eslint.config.js 与搬走的
  // skill-sources/*.mjs，本组把这批路径注册进 fast policy 并钉住注册本身）。

  it('tauri bundle.resources 映射随包树、不映射入口源目录 skill-sources', () => {
    const conf = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    const resources: Record<string, string> = conf.bundle?.resources ?? {};
    expect(resources['../resources/skills'], '运行期 skills 树必须随包').toBe('resources/skills');
    const offenders = Object.entries(resources)
      .flatMap(([from, to]) => [from, to])
      .filter((entry) => entry.includes('skill-sources'));
    expect(offenders, '入口源目录混进打包清单（release leak 会复发）').toEqual([]);
  });

  it('bundler 只从 skill-sources 读入口、产物落随包 scripts/，旧 scripts/src 路径不回归', () => {
    const bundler = fs.readFileSync(path.join(repoRoot, 'scripts', 'bundle-frontend-slides-skill.mjs'), 'utf8');
    // 钉 path.join 段本身而不是找 'scripts/src' 子串：段拆开写时子串断言咬不住
    // （变异实测），等值断言对「入口挪回随包树任何位置」都红。
    const joinSegments = (init: string) => init.split(',').map((part) => part.trim().replace(/^'|'$/g, '')).join('/');
    const sourcesInit = bundler.match(/const skillSources = path\.join\(repoRoot, ([^)]+)\)/)?.[1];
    const scriptsInit = bundler.match(/const skillScripts = path\.join\(repoRoot, ([^)]+)\)/)?.[1];
    expect(sourcesInit, 'bundler 必须声明 skillSources 入口目录').toBeTruthy();
    expect(scriptsInit, 'bundler 必须声明 skillScripts 产物目录').toBeTruthy();
    expect(joinSegments(sourcesInit!), 'esbuild 入口源只许住不随包的 resources/skill-sources').toBe('resources/skill-sources/frontend-slides');
    expect(joinSegments(scriptsInit!), 'bundler 产物只许落随包 scripts/').toBe('resources/skills/frontend-slides/scripts');
    for (const source of WRAPPERS) {
      expect(fs.existsSync(path.join(sourcesDir, source)), `入口源缺 resources/skill-sources/frontend-slides/${source}`).toBe(true);
      const bundle = source.replace(/\.mjs$/, '.bundle.mjs');
      expect(fs.existsSync(path.join(skillDir, 'scripts', bundle)), `bundler 产物缺随包 scripts/${bundle}`).toBe(true);
    }
  });

  it('lint 接线：生成物走全局 ignores，手写源/wrapper 拿到 node globals', () => {
    const config = fs.readFileSync(path.join(repoRoot, 'eslint.config.js'), 'utf8');
    expect(config, '生成物 *.bundle.mjs 必须留在全局 ignores').toContain("'resources/skills/frontend-slides/scripts/*.bundle.mjs'");
    expect(config, '入口源 .mjs 必须拿到 process/console globals').toContain("'resources/skill-sources/**/*.mjs'");
    expect(config, '随包 wrapper .mjs 必须拿到 process/console globals').toContain("'resources/skills/frontend-slides/scripts/*.mjs'");
  });

  it('gates:fast 已注册这批打包路径：任一改动都路由回本测试，不再需要 --regressions', () => {
    const rule = policy.rules.find((entry) => entry.files.includes(thisTest));
    expect(rule, 'fast policy 缺 frontend-slides 打包路由规则').toBeTruthy();
    // 覆盖本单全部改动路径形态：lint 接线、打包映射、bundler、随包树（含被搬走的
    // 旧 scripts/src 路径与生成物）、入口源新家。未注册的路径 selectTests 会直接抛
    // 「unregistered PR paths」。
    const representative = [
      'eslint.config.js',
      'src-tauri/tauri.conf.json',
      'scripts/bundle-frontend-slides-skill.mjs',
      'resources/skills/frontend-slides/scripts/src/merge-to-pdf.mjs',
      'resources/skills/frontend-slides/scripts/merge-to-pdf.bundle.mjs',
      'resources/skill-sources/frontend-slides/merge-to-pdf.mjs',
    ];
    for (const changed of representative) {
      expect(selectTests(policy, [changed]).files, changed).toContain(thisTest);
    }
  });
});

describe('frontend-slides 随包清单', () => {
  it('打包树里没有任何 /src/ 路径：esbuild 入口源只许住在 resources/skill-sources/', () => {
    const files = walkFiles(skillDir);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
      .filter((relative) => relative.includes('/src/'));
    expect(offenders, '随包树混入 /src/ 源码（release leak 会炸发版扫描）').toEqual([]);
  });

  it('release-security-scan 扫整个随包 skills 树 rc=0', () => {
    const result = spawnSync(process.execPath, [scanScript, 'resources/skills'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('[release-security-scan] passed');
  });

  it('运行期文件齐全：SKILL.md + 三个 wrapper + 三个 .bundle.mjs', () => {
    const required = [
      'SKILL.md',
      ...WRAPPERS.map((wrapper) => `scripts/${wrapper}`),
      ...WRAPPERS.map((wrapper) => `scripts/${wrapper.replace(/\.mjs$/, '.bundle.mjs')}`),
    ];
    for (const relative of required) {
      expect(fs.existsSync(path.join(skillDir, relative)), `随包缺 ${relative}`).toBe(true);
    }
  });

  it('每个 wrapper import 的 bundle 文件真实存在于同目录', () => {
    for (const wrapper of WRAPPERS) {
      const source = fs.readFileSync(path.join(skillDir, 'scripts', wrapper), 'utf8');
      const bundles = [...source.matchAll(/['"]([\w./-]+\.bundle\.mjs)['"]/g)]
        .map((match) => path.basename(match[1]));
      expect(bundles.length, `${wrapper} 未声明任何 .bundle.mjs`).toBeGreaterThan(0);
      for (const bundle of bundles) {
        expect(
          fs.existsSync(path.join(skillDir, 'scripts', bundle)),
          `${wrapper} 引用的 ${bundle} 缺失`,
        ).toBe(true);
      }
    }
  });
});

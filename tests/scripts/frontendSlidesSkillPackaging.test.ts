import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

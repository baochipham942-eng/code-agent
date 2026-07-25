// ============================================================================
// 文档技术栈版本 vs package.json 一致性门（1 秒级，挂 npm test）。
// 2026-07-25 费曼审计：README/CLAUDE/ARCHITECTURE 写 React 18/TS 5.6/Tailwind 3.4，
// 实际 19/6/4（迁移记录在 ARCHITECTURE.md 里，表格行漏改）。
//
// 门的自举纪律（feedback_gate_must_report_own_blindspot）：
// - 锚定「技术栈表格行」而不是全文正则——避开迁移历史（"React 18→19"）和
//   typecheck 工具链（"TypeScript 7 native preview"）这类合法的其他版本号；
// - 锚点行找不到 → 报红，不假绿。
// ============================================================================
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

function majorOf(dep: string): string {
  const range = deps[dep];
  expect(range, `package.json 里找不到依赖 ${dep}——门锚点失效，先修门`).toBeTruthy();
  const m = /(\d+)/.exec(range);
  expect(m, `无法从 ${dep} 版本 "${range}" 提取主版本`).toBeTruthy();
  return (m as RegExpExecArray)[1];
}

interface StackClaim {
  file: string;
  /** 锚定技术栈声明行的正则（不做全文扫描） */
  anchor: RegExp;
  /** 该行里要核对的库 → 提取版本的正则 */
  libs: Partial<Record<'react' | 'typescript' | 'tailwindcss', RegExp>>;
}

const CLAIMS: StackClaim[] = [
  {
    file: 'README.md',
    anchor: /^\|\s*前端\s*\|.*$/m,
    libs: {
      react: /React\s+(\d+)/,
      typescript: /TypeScript\s+(\d+)/,
      tailwindcss: /Tailwind\s+(\d+)/,
    },
  },
  {
    file: 'CLAUDE.md',
    anchor: /^-\s*\*\*框架\*\*.*$/m,
    libs: { react: /React\s+(\d+)/ },
  },
  {
    file: 'docs/ARCHITECTURE.md',
    anchor: /^\|\s*前端框架\s*\|.*$/m,
    libs: { react: /React\s+(\d+)/, typescript: /TypeScript\s+(\d+)/ },
  },
  {
    file: 'docs/ARCHITECTURE.md',
    anchor: /^\|\s*样式\s*\|.*$/m,
    libs: { tailwindcss: /Tailwind\s+CSS\s+(\d+)/ },
  },
  {
    file: '.claude/rules/performance.md',
    anchor: /^-\s*\*\*框架\*\*.*$/m,
    libs: { react: /React\s+(\d+)/ },
  },
];

describe('docs tech-stack versions match package.json', () => {
  it('has at least one claim to check (gate is not scanning zero targets)', () => {
    expect(CLAIMS.length).toBeGreaterThan(0);
  });

  for (const claim of CLAIMS) {
    const label = `${claim.file} :: ${claim.anchor.source}`;
    it(`keeps ${label} in sync`, () => {
      const content = fs.readFileSync(path.join(repoRoot, claim.file), 'utf-8');
      const anchorMatch = claim.anchor.exec(content);
      expect(
        anchorMatch,
        `${claim.file} 里找不到技术栈锚点行（${claim.anchor.source}）——文档改了结构就同步更新本门的锚点，别让门空转假绿`,
      ).toBeTruthy();
      const line = (anchorMatch as RegExpExecArray)[0];

      for (const [dep, versionRe] of Object.entries(claim.libs)) {
        const versionMatch = versionRe.exec(line);
        expect(
          versionMatch,
          `${claim.file} 锚点行里找不到 ${dep} 的版本声明（行内容：${line.trim()}）`,
        ).toBeTruthy();
        const claimed = (versionMatch as RegExpExecArray)[1];
        expect(
          claimed,
          `${claim.file} 声明 ${dep} 主版本 ${claimed}，package.json 实际 ${majorOf(dep)}（行：${line.trim()}）`,
        ).toBe(majorOf(dep));
      }
    });
  }
});

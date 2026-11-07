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

// ============================================================================
// ADR 索引一致性门（2026-10-28 补）：docs/ARCHITECTURE.md §ADR 索引的每一行，
// 编号列、链接标签号与目标文件必须一一对应且目标存在。起因：决策编号撞号
// （native-dep-manifest 与 cloud-run-ledger 曾同用 086），ledger 侧改号 087 后
// 索引行若漏改，链接悬空没有任何既有门会红——这条钉子把「改号后索引必须跟着改」固化。
// 自举纪律同上：锚点章节找不到 → 报红，不假绿。
// ============================================================================
interface AdrIndexRow {
  rowNumber: string;
  labelNumber: string;
  target: string;
}

function adrIndexRows(): AdrIndexRow[] {
  const content = fs.readFileSync(path.join(repoRoot, 'docs/ARCHITECTURE.md'), 'utf-8');
  const headingMatch = /^## .*ADR 索引.*$/m.exec(content);
  expect(
    headingMatch,
    'docs/ARCHITECTURE.md 里找不到 ADR 索引章节标题——文档改了结构就同步更新本门的锚点，别让门空转假绿',
  ).toBeTruthy();
  const start = (headingMatch as RegExpExecArray).index + (headingMatch as RegExpExecArray)[0].length;
  const rest = content.slice(start);
  const nextHeading = /^## /m.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  const rows: AdrIndexRow[] = [];
  const rowRe = /^\|\s*(\d{3})\s*\|[^\n]*\[ADR-(\d{3})\]\(([^)]+)\)/gm;
  for (let m = rowRe.exec(section); m; m = rowRe.exec(section)) {
    rows.push({ rowNumber: m[1], labelNumber: m[2], target: m[3] });
  }
  return rows;
}

describe('docs ADR 索引行与决策文件一致', () => {
  it('has at least one ADR row to check (gate is not scanning zero targets)', () => {
    expect(adrIndexRows().length).toBeGreaterThanOrEqual(10);
  });

  it('每行的编号列 = 链接标签号 = 目标文件名前缀，且目标文件存在', () => {
    for (const row of adrIndexRows()) {
      expect(
        row.labelNumber,
        `docs/ARCHITECTURE.md ADR 索引行 ${row.rowNumber} 的链接标签是 ADR-${row.labelNumber}，与编号列不一致（目标 ${row.target}）`,
      ).toBe(row.rowNumber);
      expect(
        row.target.startsWith(`./architecture/decisions/ADR-${row.rowNumber}-`),
        `docs/ARCHITECTURE.md ADR 索引行 ${row.rowNumber} 的目标文件名不带同号前缀：${row.target}`,
      ).toBe(true);
      expect(
        // 链接写在 docs/ARCHITECTURE.md 里，目标相对 docs/ 解析
        fs.existsSync(path.join(repoRoot, 'docs', row.target)),
        `docs/ARCHITECTURE.md ADR 索引行 ${row.rowNumber} 链接目标缺失：${row.target}——ADR 改号或改名后同步更新索引行`,
      ).toBe(true);
    }
  });
});

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

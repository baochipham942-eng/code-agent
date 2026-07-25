// ============================================================================
// 「开关必须有主人」lint（2026-07-25 费曼审计 P2-4）
//
// 任何带「以后再改」语义的 *_DEFAULT 常量，注释必须含复查日期（YYYY-MM-DD）
// 或 ticket 引用（#123），否则报红——防止「首版先这样」永远停在首版
// （标本：MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT 从建成起没人负责翻）。
//
// 门的自举：扫到 0 个 *_DEFAULT 常量 → 报红（锚点失效不假绿）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

const DEFERRAL_MARKERS = /首版|暂时|以后|再改|先上|待定|回头|later|temporar|for now|placeholder|TODO/i;
const OWNER_ANCHOR = /\d{4}-\d{2}-\d{2}|#\d{2,}/;

interface Hit {
  file: string;
  line: number;
  comment: string;
}

function collectDefaultConsts(): Hit[] {
  // git grep 列出候选行；上下文注释再逐个读文件取
  const out = execFileSync(
    'git',
    ['grep', '-n', '-E', '(const [A-Za-z0-9_]+_DEFAULT\\s*=|[A-Z0-9_]+_DEFAULT\\s*:)', '--', 'src/*.ts', 'src/**/*.ts'],
    { cwd: repoRoot, encoding: 'utf-8' },
  );
  const hits: Hit[] = [];
  for (const row of out.trim().split('\n')) {
    const m = /^([^:]+):(\d+):/.exec(row);
    if (!m) continue;
    const [, file, lineStr] = m;
    const lineNo = Number(lineStr);
    const lines = fs.readFileSync(path.join(repoRoot, file), 'utf-8').split('\n');
    // 注释上下文：向上收集连续注释行（// 或 块注释），加本行行尾
    const ctx: string[] = [lines[lineNo - 1]];
    for (let i = lineNo - 2; i >= 0 && i >= lineNo - 12; i -= 1) {
      const t = lines[i].trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t === '*/') {
        ctx.unshift(lines[i]);
      } else {
        break;
      }
    }
    hits.push({ file, line: lineNo, comment: ctx.join('\n') });
  }
  return hits;
}

describe('switch owner lint', () => {
  const hits = collectDefaultConsts();

  it('finds at least one *_DEFAULT constant (gate anchor sanity)', () => {
    expect(hits.length, '全仓扫不到任何 *_DEFAULT 常量——扫描锚点失效，先修门').toBeGreaterThan(0);
  });

  it('every deferred-semantics *_DEFAULT has a review date or ticket', () => {
    const orphans = hits.filter(
      (h) => DEFERRAL_MARKERS.test(h.comment) && !OWNER_ANCHOR.test(h.comment),
    );
    expect(
      orphans,
      `以下 *_DEFAULT 带「以后再改」语义但没有复查日期/ticket（注释里补 YYYY-MM-DD 或 #ticket）：\n${orphans
        .map((o) => `  ${o.file}:${o.line}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});

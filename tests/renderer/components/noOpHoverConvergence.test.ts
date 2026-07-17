// ============================================================================
// no-op hover 棘轮：className 里 `(bg|text|border)-X ... hover:同一个 X`
// 是笔误（hover 态和静止态颜色完全一样，等于没写 hover），不是设计选择。
// 扫全 src/renderer（含 lab 域——这是笔误模式不是设计选择，不比照
// primaryActionConvergence 排除 lab）。白名单为空：目前没有任何一处需要保留
// 同值 hover，新出现的一律视为笔误，改掉或在这里登记理由再放行。
// 同套路照抄 settingsToggleConvergence.test.ts（PR #430）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RENDERER_DIR = path.resolve(__dirname, '../../../src/renderer');

/** 允许 (bg|text|border)-X 静止态和 hover:X 同值的文件（相对 src/renderer）→ 允许的最大出现次数 */
const ALLOWLIST: Record<string, number> = {};

// 同一 className 字符串内，(bg|text|border)-颜色-色阶(/透明度) 后面（120 字符窗口内，
// 不跨引号/反引号，即不跨 ternary 的另一个分支）出现 hover:同一个颜色串。
// 排除 group-hover:/peer-hover: 前缀（那是父元素触发，语义不同）。
const NOOP_HOVER_RE = /\b(bg|text|border)-([a-zA-Z]+-\d{2,4}(?:\/\d{1,3})?)(?=[\s"'`])((?:(?!hover:)[^'"`\n]){0,120}?)(?<![-\w])hover:\1-\2(?=[\s"'`]|$)/g;

function listCandidateFiles(): string[] {
  let out = '';
  try {
    out = execFileSync('grep', ['-rl', 'hover:', RENDERER_DIR, '--include=*.tsx', '--include=*.ts'], {
      encoding: 'utf-8',
    });
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return []; // 零命中（理论上不该发生，下面 fail-loud 兜底）
    throw new Error(`no-op hover 门自身故障（grep exit ${e.status}）：${String(err)}`);
  }
  return out.trim().split('\n').filter(Boolean);
}

function scanNoOpHovers(): Map<string, number> {
  const files = listCandidateFiles();
  if (files.length === 0) {
    throw new Error('no-op hover 门自身故障：grep 找不到任何含 hover: 的文件，扫描面为空——门失效了，不是真的零命中');
  }
  const counts = new Map<string, number>();
  for (const filePath of files) {
    const src = fs.readFileSync(filePath, 'utf-8');
    NOOP_HOVER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = NOOP_HOVER_RE.exec(src))) n++;
    if (n > 0) {
      const file = path.relative(RENDERER_DIR, filePath);
      counts.set(file, n);
    }
  }
  return counts;
}

describe('no-op hover 棘轮（同值 hover 只增不减白名单，扫全域含 lab）', () => {
  it('白名单文件都仍存在对应数量的命中（防清单腐烂假绿）', () => {
    const counts = scanNoOpHovers();
    for (const [file, max] of Object.entries(ALLOWLIST)) {
      expect(counts.get(file) ?? 0, `${file} 应恰有 ${max} 处（改动/删除需同步白名单）`).toBe(max);
    }
  });

  it('白名单之外零 no-op hover——同值 hover 一律改掉', () => {
    const counts = scanNoOpHovers();
    const offenders = [...counts.entries()]
      .filter(([file, n]) => (ALLOWLIST[file] ?? 0) < n)
      .map(([file, n]) => `${file}: ${n} 处（允许 ${ALLOWLIST[file] ?? 0}）`);
    expect(offenders, `发现 no-op hover（静止态和 hover 态颜色相同），请修正：\n${offenders.join('\n')}`).toEqual([]);
  });
});

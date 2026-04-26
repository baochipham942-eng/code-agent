// V2-B tweakWriter 单测 — 覆盖 className 4 类形态 + 拒绝表达式
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTweak } from '../../../../src/main/tools/livePreview/tweakWriter';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tweak-writer-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('applyTweak: StringLiteral className', () => {
  it('className="px-4 bg-blue-500" → 改 padding', () => {
    const src = `export const X = () => <button className="px-4 bg-blue-500">Hi</button>;\n`;
    // <button 在 line 1, JSXOpeningElement loc.start 指向 < (0-indexed col 23)
    const file = fixture('a.tsx', src);
    const res = applyTweak({ file, line: 1, column: 23 }, { kind: 'spacing', axis: 'px', value: 8 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newClassName).toBe('px-8 bg-blue-500');
    const after = readFileSync(file, 'utf-8');
    expect(after).toContain('className="px-8 bg-blue-500"');
  });
});

describe('applyTweak: JSXExpressionContainer + StringLiteral', () => {
  it('className={"p-4"} → p-8', () => {
    const src = `const X = () => <div className={"p-4 flex"}>x</div>;\n`;
    const file = fixture('b.tsx', src);
    const res = applyTweak({ file, line: 1, column: 16 }, { kind: 'spacing', axis: 'p', value: 8 });
    expect(res.ok).toBe(true);
    const after = readFileSync(file, 'utf-8');
    expect(after).toContain('className={"p-8 flex"}');
  });
});

describe('applyTweak: TemplateLiteral 纯字面', () => {
  it('className={`text-red-500 p-4`} → 改色', () => {
    const src = 'const X = () => <span className={`text-red-500 p-4`}>x</span>;\n';
    const file = fixture('c.tsx', src);
    const res = applyTweak({ file, line: 1, column: 16 }, { kind: 'color', target: 'text', color: 'green', shade: 600 });
    expect(res.ok).toBe(true);
    const after = readFileSync(file, 'utf-8');
    expect(after).toContain('className={`text-green-600 p-4`}');
  });
});

describe('applyTweak: 拒绝表达式', () => {
  it('className={cn(...)} → ok=false reason=expression', () => {
    const src = `const X = () => <div className={cn('p-4', isActive && 'bg-blue-500')}>x</div>;\n`;
    const file = fixture('d.tsx', src);
    const res = applyTweak({ file, line: 1, column: 16 }, { kind: 'spacing', axis: 'p', value: 8 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('expression');
  });

  it('className={isActive ? "a" : "b"} 拒绝', () => {
    const src = `const X = () => <div className={isActive ? "p-4" : "p-2"}>x</div>;\n`;
    const file = fixture('e.tsx', src);
    const res = applyTweak({ file, line: 1, column: 16 }, { kind: 'spacing', axis: 'p', value: 8 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('expression');
  });

  it('className={`p-${size}`} 含动态表达式 拒绝', () => {
    const src = 'const X = () => <div className={`p-${4}`}>x</div>;\n';
    const file = fixture('f.tsx', src);
    const res = applyTweak({ file, line: 1, column: 16 }, { kind: 'spacing', axis: 'p', value: 8 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('expression');
  });

  it('className={dynamicClass} Identifier 拒绝', () => {
    const src = `const X = () => <div className={cls}>x</div>;\n`;
    const file = fixture('g.tsx', src);
    const res = applyTweak({ file, line: 1, column: 16 }, { kind: 'spacing', axis: 'p', value: 8 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('expression');
  });
});

describe('applyTweak: 边界 case', () => {
  it('mutation 同值 → noop', () => {
    const src = `const X = () => <div className="p-4">x</div>;\n`;
    const file = fixture('h.tsx', src);
    const res = applyTweak({ file, line: 1, column: 16 }, { kind: 'spacing', axis: 'p', value: 4 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('noop');
    // 文件内容不变
    expect(readFileSync(file, 'utf-8')).toBe(src);
  });

  it('元素没 className → no-className（不自动插入）', () => {
    const src = `const X = () => <div>x</div>;\n`;
    const file = fixture('i.tsx', src);
    const res = applyTweak({ file, line: 1, column: 16 }, { kind: 'spacing', axis: 'p', value: 4 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('no-className');
  });

  it('找不到指定 line:col 元素 → element-not-found', () => {
    const src = `const X = () => <div className="p-4">x</div>;\n`;
    const file = fixture('j.tsx', src);
    const res = applyTweak({ file, line: 5, column: 16 }, { kind: 'spacing', axis: 'p', value: 8 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('element-not-found');
  });

  it('文件不存在 → io', () => {
    const res = applyTweak({ file: '/tmp/__not_exist__.tsx', line: 1, column: 0 }, { kind: 'spacing', axis: 'p', value: 4 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('io');
  });

  it('应用后 mutation.removed/added 体现真实 diff', () => {
    const src = `const X = () => <div className="p-4 bg-blue-500">x</div>;\n`;
    const file = fixture('k.tsx', src);
    const res = applyTweak({ file, line: 1, column: 16 }, { kind: 'color', target: 'bg', color: 'red', shade: 600 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mutation.removed).toEqual(['bg-blue-500']);
    expect(res.mutation.added).toEqual(['bg-red-600']);
  });
});

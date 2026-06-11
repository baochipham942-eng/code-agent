import { describe, it, expect } from 'vitest';
import {
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  IndentationFlexibleReplacer,
  findFlexibleMatch,
  levenshtein,
} from '../../../src/main/tools/utils/editReplacers';

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });
});

describe('LineTrimmedReplacer', () => {
  it('matches lines that differ only by surrounding whitespace', () => {
    const content = 'function foo() {\n    return 1;  \n}\n';
    const find = 'function foo() {\nreturn 1;\n}';
    const matches = [...LineTrimmedReplacer(content, find)];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe('function foo() {\n    return 1;  \n}');
  });

  it('yields nothing when line content differs', () => {
    const content = 'function foo() {\n  return 2;\n}\n';
    const find = 'function foo() {\nreturn 1;\n}';
    expect([...LineTrimmedReplacer(content, find)]).toHaveLength(0);
  });

  it('tolerates a trailing empty line in the search block', () => {
    const content = 'a\nb\nc\n';
    const find = 'a\nb\n';
    const matches = [...LineTrimmedReplacer(content, find)];
    expect(matches[0]).toBe('a\nb');
  });
});

describe('BlockAnchorReplacer', () => {
  it('matches a block by first/last anchor lines with fuzzy middle', () => {
    const content = [
      'function process(data) {',
      '  const result = transform(data); // 注释略有不同',
      '  return result;',
      '}',
    ].join('\n');
    const find = [
      'function process(data) {',
      '  const result = transform(data);',
      '  return result;',
      '}',
    ].join('\n');
    const matches = [...BlockAnchorReplacer(content, find)];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain('function process(data) {');
    expect(matches[0]).toContain('}');
  });

  it('requires at least 3 lines in the search block', () => {
    expect([...BlockAnchorReplacer('a\nb', 'a\nb')]).toHaveLength(0);
  });

  it('rejects a two-line search block with trailing newline (codex audit R4 MED)', () => {
    // 'a\nb\n'.split 后长度为 3 会骗过行数门，去尾空行后只剩两行纯锚点，
    // 不允许把 'a\nx\nb' 当成锚点全匹配吞掉中间行
    expect([...BlockAnchorReplacer('a\nx\nb', 'a\nb\n')]).toHaveLength(0);
  });

  it('picks the most similar candidate among multiple anchor matches (0.3 threshold)', () => {
    const content = [
      'if (x) {',
      '  completely different body here',
      '}',
      'other code',
      'if (x) {',
      '  doWork(x);',
      '}',
    ].join('\n');
    const find = ['if (x) {', '  doWork(x);', '}'].join('\n');
    const matches = [...BlockAnchorReplacer(content, find)];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain('doWork(x);');
  });
});

describe('IndentationFlexibleReplacer', () => {
  it('matches blocks with a uniform indentation offset', () => {
    const content = [
      'class A {',
      '    method() {',
      '        return 1;',
      '    }',
      '}',
    ].join('\n');
    const find = ['method() {', '    return 1;', '}'].join('\n');
    const matches = [...IndentationFlexibleReplacer(content, find)];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(['    method() {', '        return 1;', '    }'].join('\n'));
  });

  it('yields nothing when relative indentation differs', () => {
    const content = 'a() {\nreturn 1;\n}';
    const find = 'a() {\n    return 1;\n}';
    expect([...IndentationFlexibleReplacer(content, find)]).toHaveLength(0);
  });
});

describe('BlockAnchorReplacer — 单候选误匹配防护 (codex audit R1 HIGH)', () => {
  it('rejects a single candidate whose body is unrelated (nested wrong block)', () => {
    // Codex repro：首行锚点 + 最近的 '}' 形成错误的嵌套块候选，
    // 中间行 'if(x){' 与 'return x;' 相似度极低，必须被阈值挡掉
    const content = [
      'function foo(){',
      '  if(x){',
      '    doThing();',
      '  }',
      '  return x;',
      '}',
    ].join('\n');
    const find = ['function foo(){', '  return x;', '}'].join('\n');
    const matches = [...BlockAnchorReplacer(content, find)];
    expect(matches).toHaveLength(0);
  });

  it('still accepts a single candidate with genuinely similar middle lines', () => {
    const content = ['function foo(){', '  return x; // ok', '}'].join('\n');
    const find = ['function foo(){', '  return x;', '}'].join('\n');
    const matches = [...BlockAnchorReplacer(content, find)];
    expect(matches).toHaveLength(1);
  });

  it('picks the full outer block over a truncated inner-brace candidate (codex audit R2 HIGH)', () => {
    // Codex repro：首个 '}' 是嵌套 if 的闭合，截断候选的前两行中间行完全相同，
    // 必须考虑所有 tail anchor 并按完整 search 块长度打分，选外层完整块
    const content = [
      'function foo() {',
      '  if (ok) {',
      '    return value;',
      '  }',
      '  return fallback;',
      '}',
    ].join('\n');
    const find = [
      'function foo() {',
      '  if (ok) {',
      '    return value;',
      '  }',
      '  return fallbackValue;',
      '}',
    ].join('\n');
    const matches = [...BlockAnchorReplacer(content, find)];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(content); // 完整外层块，而非截断到 line3
  });

  it('finds the outer block even when 64+ inner tail anchors precede it (codex audit R3 MED)', () => {
    // 巨型块：70 个嵌套 if 的 '}' 都排在外层 '}' 之前。
    // 候选选择必须按块长接近度取 tail，而不是按出现序取前 64 个。
    const innerBlocks = Array.from({ length: 70 }, (_, i) => [
      `  if (cond${i}) {`,
      `    work${i}();`,
      '  }',
    ].join('\n'));
    const content = ['function giant() {', ...innerBlocks, '  finalStatement();', '}'].join('\n');
    const find = ['function giant() {', ...innerBlocks, '  finalStatementRenamed();', '}'].join('\n');

    const matches = [...BlockAnchorReplacer(content, find)];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(content); // 完整外层块
  });

  it('fails closed when start anchors exceed the safety cap (ambiguity too high)', () => {
    const repeated = Array.from({ length: 70 }, (_, i) => ['dup {', `  v${i};`, '}'].join('\n'));
    const content = repeated.join('\n');
    const find = ['dup {', '  something;', '}'].join('\n');
    // 70 个同名 start anchor：歧义过高，宁可不出候选也不能选错
    const matches = [...BlockAnchorReplacer(content, find)];
    expect(matches).toHaveLength(0);
  });

  it('rejects a lone truncated candidate when the search block is much longer', () => {
    // 只有截断候选可选时（外层 '}' 不存在），按完整块长打分应低于阈值被拒
    const content = [
      'function foo() {',
      '  if (ok) {',
      '    return value;',
      '  }',
      '  return fallback;',
    ].join('\n');
    const find = [
      'function foo() {',
      '  if (ok) {',
      '    return value;',
      '  }',
      '  doA();',
      '  doB();',
      '  doC();',
      '  doD();',
      '}',
    ].join('\n');
    const matches = [...BlockAnchorReplacer(content, find)];
    expect(matches).toHaveLength(0);
  });
});

describe('findFlexibleMatch（链式回退）', () => {
  it('returns the in-content substring for a line-trim difference', () => {
    const content = 'foo() {\n   bar();   \n}\n';
    const result = findFlexibleMatch(content, 'foo() {\nbar();\n}');
    expect(result).not.toBeNull();
    expect(result!.match).toBe('foo() {\n   bar();   \n}');
    expect(result!.occurrences).toBe(1);
    expect(content.includes(result!.match)).toBe(true);
  });

  it('returns null when nothing matches', () => {
    expect(findFlexibleMatch('hello world', 'goodbye')).toBeNull();
  });

  it('marks ambiguous candidates with occurrences > 1 (caller reports AMBIGUOUS)', () => {
    const content = 'x\n  a();\nx\n  a();\nx\n';
    const single = findFlexibleMatch(content, 'a();');
    expect(single).not.toBeNull();
    expect(single!.occurrences).toBeGreaterThan(1);
  });

  it('does not fire on exact-match content (caller handles exact first)', () => {
    // 防御性：即使调用方传了精确可匹配的串，返回的 match 也等价
    const content = 'const a = 1;\n';
    const result = findFlexibleMatch(content, 'const a = 1;');
    expect(result?.match).toBe('const a = 1;');
  });
});

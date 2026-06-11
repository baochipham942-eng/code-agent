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

describe('findFlexibleMatch（链式回退）', () => {
  it('returns the in-content substring for a line-trim difference', () => {
    const content = 'foo() {\n   bar();   \n}\n';
    const result = findFlexibleMatch(content, 'foo() {\nbar();\n}', false);
    expect(result).not.toBeNull();
    expect(result!.match).toBe('foo() {\n   bar();   \n}');
    expect(result!.occurrences).toBe(1);
    expect(content.includes(result!.match)).toBe(true);
  });

  it('returns null when nothing matches', () => {
    expect(findFlexibleMatch('hello world', 'goodbye', false)).toBeNull();
  });

  it('skips ambiguous candidates unless replaceAll', () => {
    const content = 'x\n  a();\nx\n  a();\nx\n';
    // LineTrimmed 会对 'a();' 产出两个相同 candidate（两处出现）→ 非 replaceAll 标记歧义
    const single = findFlexibleMatch(content, 'a();', false);
    expect(single).not.toBeNull();
    expect(single!.occurrences).toBeGreaterThan(1);

    const all = findFlexibleMatch(content, 'a();', true);
    expect(all).not.toBeNull();
    expect(all!.occurrences).toBe(2);
  });

  it('does not fire on exact-match content (caller handles exact first)', () => {
    // 防御性：即使调用方传了精确可匹配的串，返回的 match 也等价
    const content = 'const a = 1;\n';
    const result = findFlexibleMatch(content, 'const a = 1;', false);
    expect(result?.match).toBe('const a = 1;');
  });
});

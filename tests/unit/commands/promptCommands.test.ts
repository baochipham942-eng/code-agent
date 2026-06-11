// ============================================================================
// Prompt command 协议层 — 纯逻辑（roadmap 2.2）
// ============================================================================
// /命令的模板语义：$1..$N 位置参数 + $ARGUMENTS 全量参数；
// 文件式自定义命令的 frontmatter（description/agent/model/subtask）解析；
// /name args 调用解析。
// ============================================================================

import { describe, it, expect } from 'vitest';

import {
  computeHints,
  expandPromptTemplate,
  parsePromptCommandFile,
  parseSlashInvocation,
} from '../../../src/shared/commands/promptCommands';

describe('parseSlashInvocation', () => {
  it('parses /name with args', () => {
    expect(parseSlashInvocation('/review HEAD~3..HEAD --fast')).toEqual({
      name: 'review',
      args: 'HEAD~3..HEAD --fast',
    });
  });

  it('parses bare /name with empty args', () => {
    expect(parseSlashInvocation('/dream')).toEqual({ name: 'dream', args: '' });
  });

  it('allows dash and underscore in names', () => {
    expect(parseSlashInvocation('/deep-research quantum')).toEqual({
      name: 'deep-research',
      args: 'quantum',
    });
  });

  it('returns null for non-command content', () => {
    expect(parseSlashInvocation('hello world')).toBeNull();
    expect(parseSlashInvocation('/ leading space')).toBeNull();
    expect(parseSlashInvocation('//double')).toBeNull();
    expect(parseSlashInvocation('')).toBeNull();
  });

  it('keeps multi-line args intact', () => {
    expect(parseSlashInvocation('/fix line one\nline two')).toEqual({
      name: 'fix',
      args: 'line one\nline two',
    });
  });
});

describe('computeHints', () => {
  it('collects numbered placeholders sorted and deduped', () => {
    expect(computeHints('do $2 then $1 then $2')).toEqual(['$1', '$2']);
  });

  it('collects $ARGUMENTS after numbered ones', () => {
    expect(computeHints('run $1 with $ARGUMENTS')).toEqual(['$1', '$ARGUMENTS']);
  });

  it('returns empty for templates without placeholders', () => {
    expect(computeHints('no placeholders here')).toEqual([]);
  });
});

describe('expandPromptTemplate', () => {
  it('substitutes $ARGUMENTS with the raw args string', () => {
    expect(expandPromptTemplate('research: $ARGUMENTS', 'ai pm jobs')).toBe('research: ai pm jobs');
  });

  it('substitutes positional $1/$2 from whitespace-tokenized args', () => {
    expect(expandPromptTemplate('from $1 to $2', 'main release')).toBe('from main to release');
  });

  it('supports double-quoted tokens as single arguments', () => {
    expect(expandPromptTemplate('title: $1, rest: $2', '"hello world" tail')).toBe('title: hello world, rest: tail');
  });

  it('replaces missing positional args with empty string', () => {
    expect(expandPromptTemplate('a=$1 b=$2', 'only')).toBe('a=only b=');
  });

  it('does not confuse $1 with $10', () => {
    const args = 'a b c d e f g h i j';
    expect(expandPromptTemplate('$10|$1', args)).toBe('j|a');
  });

  it('appends args when template has no placeholders but args given', () => {
    const out = expandPromptTemplate('fixed instructions', 'extra context');
    expect(out).toContain('fixed instructions');
    expect(out).toContain('extra context');
  });

  it('returns template unchanged when no placeholders and no args', () => {
    expect(expandPromptTemplate('fixed instructions', '')).toBe('fixed instructions');
  });
});

describe('parsePromptCommandFile', () => {
  it('parses frontmatter fields and template body', () => {
    const raw = [
      '---',
      'description: review changes in scope',
      'agent: reviewer',
      'model: kimi-k2.5',
      'subtask: true',
      '---',
      'Review the following scope: $1',
      'Extra notes: $ARGUMENTS',
    ].join('\n');

    const parsed = parsePromptCommandFile('review-scope', raw);
    expect(parsed).toMatchObject({
      name: 'review-scope',
      description: 'review changes in scope',
      agent: 'reviewer',
      model: 'kimi-k2.5',
      subtask: true,
      source: 'file',
    });
    expect(parsed.template).toContain('Review the following scope: $1');
    expect(parsed.template).not.toContain('---');
    expect(parsed.hints).toEqual(['$1', '$ARGUMENTS']);
  });

  it('treats files without frontmatter as pure templates', () => {
    const parsed = parsePromptCommandFile('plain', 'Just do $ARGUMENTS');
    expect(parsed.description).toBeUndefined();
    expect(parsed.template).toBe('Just do $ARGUMENTS');
    expect(parsed.hints).toEqual(['$ARGUMENTS']);
  });

  it('ignores unknown frontmatter keys and tolerates trailing newline edge', () => {
    const raw = '---\ndescription: d\nunknown_key: zzz\n---\nbody\n';
    const parsed = parsePromptCommandFile('edge', raw);
    expect(parsed.description).toBe('d');
    expect(parsed.template).toBe('body');
  });
});

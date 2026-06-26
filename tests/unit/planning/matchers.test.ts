import { describe, expect, it } from 'vitest';
import {
  matchTool,
  matchCategory,
  matchers,
  matchDangerousBash,
} from '../../../src/host/planning/matchers';
import { TOOL_CATEGORIES } from '../../../src/host/planning/hooks/types';
import type { HookContext } from '../../../src/host/planning/types';

const ctx = (over: Partial<HookContext> = {}): HookContext => ({ ...over });

describe('matchTool', () => {
  it('returns false when context has no toolName', () => {
    expect(matchTool(ctx(), 'bash')).toBe(false);
  });

  it('matches when toolName is in the provided list', () => {
    expect(matchTool(ctx({ toolName: 'bash' }), 'write_file', 'bash')).toBe(true);
  });

  it('does not match when toolName is absent from the list', () => {
    expect(matchTool(ctx({ toolName: 'read_file' }), 'bash')).toBe(false);
  });

  it('returns false with an empty tool list', () => {
    expect(matchTool(ctx({ toolName: 'bash' }))).toBe(false);
  });
});

describe('matchCategory', () => {
  // Pick a real category + member from the live category map so the test
  // stays honest against the shared TOOL_CATEGORIES source.
  const [category, tools] = Object.entries(TOOL_CATEGORIES).find(
    ([, list]) => Array.isArray(list) && list.length > 0
  ) as [keyof typeof TOOL_CATEGORIES, string[]];
  const memberTool = tools[0];

  it('returns false when context has no toolName', () => {
    expect(matchCategory(ctx(), category)).toBe(false);
  });

  it('matches a tool that belongs to the category', () => {
    expect(matchCategory(ctx({ toolName: memberTool }), category)).toBe(true);
  });

  it('does not match a tool outside the category', () => {
    expect(
      matchCategory(ctx({ toolName: '__definitely_not_a_tool__' }), category)
    ).toBe(false);
  });

  it('returns false for an unknown category', () => {
    expect(
      matchCategory(ctx({ toolName: memberTool }), 'no_such_category' as never)
    ).toBe(false);
  });
});

describe('matchers factory', () => {
  it('tools() builds a matcher over the given names', () => {
    const m = matchers.tools('bash', 'write_file');
    expect(m(ctx({ toolName: 'bash' }))).toBe(true);
    expect(m(ctx({ toolName: 'read_file' }))).toBe(false);
  });

  it('category() builds a matcher over a category', () => {
    const [category, tools] = Object.entries(TOOL_CATEGORIES).find(
      ([, list]) => Array.isArray(list) && list.length > 0
    ) as [keyof typeof TOOL_CATEGORIES, string[]];
    const m = matchers.category(category);
    expect(m(ctx({ toolName: tools[0] }))).toBe(true);
    expect(m(ctx({ toolName: '__nope__' }))).toBe(false);
  });

  it('any() always matches', () => {
    const m = matchers.any();
    expect(m(ctx())).toBe(true);
    expect(m(ctx({ toolName: 'whatever' }))).toBe(true);
  });

  it('and() requires every matcher to pass', () => {
    const yes = matchers.any();
    const no = matchers.tools('bash');
    expect(matchers.and(yes, yes)(ctx({ toolName: 'bash' }))).toBe(true);
    expect(matchers.and(yes, no)(ctx({ toolName: 'read_file' }))).toBe(false);
  });

  it('and() with no matchers matches (vacuous truth)', () => {
    expect(matchers.and()(ctx())).toBe(true);
  });

  it('or() passes when any matcher passes', () => {
    const a = matchers.tools('bash');
    const b = matchers.tools('write_file');
    expect(matchers.or(a, b)(ctx({ toolName: 'write_file' }))).toBe(true);
    expect(matchers.or(a, b)(ctx({ toolName: 'read_file' }))).toBe(false);
  });

  it('or() with no matchers does not match', () => {
    expect(matchers.or()(ctx({ toolName: 'bash' }))).toBe(false);
  });

  it('not() inverts the wrapped matcher', () => {
    const m = matchers.not(matchers.tools('bash'));
    expect(m(ctx({ toolName: 'bash' }))).toBe(false);
    expect(m(ctx({ toolName: 'read_file' }))).toBe(true);
  });
});

describe('matchDangerousBash', () => {
  const m = matchDangerousBash();

  it('ignores non-bash tools', () => {
    expect(
      m(ctx({ toolName: 'write_file', toolParams: { command: 'rm -rf /' } }))
    ).toBe(false);
  });

  it('returns false when the command is missing', () => {
    expect(m(ctx({ toolName: 'bash' }))).toBe(false);
    expect(m(ctx({ toolName: 'bash', toolParams: {} }))).toBe(false);
  });

  it.each([
    'rm -rf /',
    'rm -rf ~',
    'rm -rf *',
    'echo x > /dev/sda',
    'mkfs.ext4 /dev/sdb',
    'dd if=/dev/zero of=/dev/sda',
    'chmod -R 777 /etc',
    ':(){ :|:& };:',
  ])('flags dangerous command: %s', (command) => {
    expect(m(ctx({ toolName: 'bash', toolParams: { command } }))).toBe(true);
  });

  // The bash tool registers at runtime as 'Bash' (capital B — see
  // src/host/tools/modules/shell/bash.schema.ts). The dangerous-command
  // safety blocker must fire for the real tool name, not just lowercase.
  it.each(['Bash', 'BASH'])('flags dangerous commands for tool name "%s"', (toolName) => {
    expect(m(ctx({ toolName, toolParams: { command: 'rm -rf /' } }))).toBe(true);
  });

  it.each(['ls -la', 'rm file.txt', 'git status', 'chmod 644 file'])(
    'allows safe command: %s',
    (command) => {
      expect(m(ctx({ toolName: 'bash', toolParams: { command } }))).toBe(false);
    }
  );
});

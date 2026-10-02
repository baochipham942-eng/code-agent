// Pins the tail of a long directory listing through L1 and bash truncation.
// resolveToolResultBudget derives the L1 token cap, the L0 archive threshold
// and the Bash character cap from the context window. The 32K, 200K and 1M
// tiers each use a listing that exceeds that tier. A 69-line listing of
// 60–80 character rows sits under the compiled default of 2000 tokens, so
// the default-budget case repeats the same row shape until 2000 is exceeded.
// That is the case a head-only truncation must fail.

import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  applyActiveToolResultPrune,
  ACTIVE_PRUNE_PLACEHOLDER_MARKER,
  getFreshToolResultMessageIds,
} from '../../../../src/host/context/layers/activeToolResultPrune';
import { applyToolResultBudget, resolveToolResultBudget } from '../../../../src/host/context/layers/toolResultBudget';
import { CompressionState } from '../../../../src/host/context/compressionState';
import { estimateTokens } from '../../../../src/host/context/tokenEstimator';
import { truncateMiddleErrorAware } from '../../../../src/host/utils/truncate';
import { ACTIVE_TOOL_RESULT_PRUNE } from '../../../../src/shared/constants/agent';
import { BASH } from '../../../../src/shared/constants/tools';

const spillTestRoot = path.join(os.tmpdir(), `neo-ls-tail-spill-test-${process.pid}`);
const WINDOW_TIERS = [32_000, 200_000, 1_000_000] as const;

vi.mock('../../../../src/host/config/configPaths', async () => {
  const osMod = await import('os');
  const pathMod = await import('path');
  return {
    getUserConfigDir: () => pathMod.join(osMod.tmpdir(), `neo-ls-tail-spill-test-${process.pid}`),
  };
});

const LAST_DIRECTORY = '资料';
const PREVIEW_MARKER = 'preview（前 200 字符）:\n';

type ListingMessage = { id: string; role: string; content: string };

function lsLine(name: string, directory: boolean): string {
  const mode = directory ? 'drwxr-xr-x' : '-rw-r--r--';
  const links = (directory ? '12' : '1').padStart(4);
  const size = (directory ? '1888' : '4096').padStart(8);
  const line = `${mode} ${links} ${'neo'.padEnd(8)} ${'staff'.padEnd(8)} ${size} Sep 18 23:51 ${name}`;
  if (line.length >= 60 && line.length <= 80) return line;
  if (line.length < 60) return line.padEnd(60, ' ');
  throw new Error(`ls row is ${line.length} chars: ${name}`);
}

function codeEntryNames(): Array<[string, boolean]> {
  const named: Array<[string, boolean]> = [
    ['package.json', false],
    ['tsconfig.json', false],
    ['vite.config.ts', false],
    ['src', true],
    ['node_modules', true],
    ['.git', true],
    ['README.md', false],
    ['index.html', false],
    ['eslint.config.js', false],
    ['postcss.config.js', false],
    ['tailwind.config.js', false],
    ['vitest.config.ts', false],
    ['.gitignore', false],
    ['.npmrc', false],
    ['Dockerfile', false],
    ['Makefile', false],
  ];
  while (named.length < 67) {
    const index = named.length;
    named.push([`mod-${String(index).padStart(2, '0')}-source.ts`, false]);
  }
  return named;
}

function buildSixtyNineLineListing(): { text: string; lastLine: string; entryLines: string[] } {
  const entryLines = codeEntryNames().map(([name, directory]) => lsLine(name, directory));
  const lastLine = lsLine(LAST_DIRECTORY, true);
  const total = 'total 4096'.padEnd(64, ' ');
  const lines = [total, ...entryLines, lastLine];
  if (lines.length !== 69) throw new Error(`expected 69 lines, got ${lines.length}`);
  for (const line of lines) {
    if (line.length < 60 || line.length > 80) {
      throw new Error(`row width ${line.length} outside 60-80`);
    }
  }
  return { text: lines.join('\n'), lastLine, entryLines };
}

function listingOverTokens(entryLines: string[], lastLine: string, maxTokens: number): string {
  const lines = [...entryLines];
  let text = [...lines, lastLine].join('\n');
  let guard = 0;
  while (estimateTokens(text) <= maxTokens) {
    const perLine = Math.max(1, Math.floor(estimateTokens(text) / lines.length));
    const batch = Math.max(1, Math.ceil((maxTokens - estimateTokens(text) + 1) / perLine));
    for (let i = 0; i < batch; i += 1) {
      lines.push(entryLines[lines.length % entryLines.length]);
    }
    text = [...lines, lastLine].join('\n');
    guard += 1;
    if (guard > 8) throw new Error(`listing did not exceed ${maxTokens} tokens`);
  }
  return text;
}

function listingOverChars(text: string, minChars: number): string {
  const unit = text.endsWith('\n') ? text : `${text}\n`;
  let wide = '';
  while (wide.length <= minChars) wide += unit;
  return wide;
}

function staleToolResult(content: string): ListingMessage[] {
  return [
    { id: 'ls-1', role: 'tool', content },
    { id: 'a1', role: 'assistant', content: 'noted' },
  ];
}

function applyStaleBudget(content: string, maxTokensPerResult?: number): string {
  const messages = staleToolResult(content);
  const fresh = getFreshToolResultMessageIds(messages);
  if (fresh.has('ls-1')) throw new Error('listing was treated as a fresh tool result');
  const state = new CompressionState();
  applyToolResultBudget(messages, state, {
    protectedMessageIds: fresh,
    ...(maxTokensPerResult === undefined ? {} : { maxTokensPerResult }),
  });
  return messages[0].content;
}

function expectArchivedHeadPreview(
  original: string,
  lastLine: string,
  maxTokensPerResult: number,
  spillSessionId: string,
): void {
  expect(estimateTokens(original)).toBeGreaterThan(maxTokensPerResult);
  expect(Array.from(original).slice(0, 200).join('').includes(LAST_DIRECTORY)).toBe(false);

  const messages = staleToolResult(original);
  const state = new CompressionState();
  const pruned = applyActiveToolResultPrune(messages, state, {
    enabled: true,
    maxTokensPerResult,
    spillSessionId,
  });

  expect(pruned).toBe(1);
  const placeholder = messages[0].content;
  expect(placeholder.startsWith(ACTIVE_PRUNE_PLACEHOLDER_MARKER)).toBe(true);
  const archiveLine = placeholder.split('\n').find((line) => line.startsWith('archive: '));
  expect(archiveLine).toBeDefined();
  const archivePath = archiveLine?.slice('archive: '.length) ?? '';
  expect(fs.existsSync(archivePath)).toBe(true);
  expect(fs.readFileSync(archivePath, 'utf8').includes(lastLine)).toBe(true);

  const previewAt = placeholder.indexOf(PREVIEW_MARKER);
  expect(previewAt).toBeGreaterThan(0);
  const preview = placeholder.slice(previewAt + PREVIEW_MARKER.length);
  expect(preview).toBe(Array.from(original).slice(0, 200).join(''));
  expect(preview.includes(LAST_DIRECTORY)).toBe(false);
}

describe('tool result tail kept', () => {
  afterAll(() => {
    fs.rmSync(spillTestRoot, { recursive: true, force: true });
  });

  it('keeps the last line of a 69-line listing at the default 2000-token budget', () => {
    const { text, lastLine } = buildSixtyNineLineListing();
    expect(text.split('\n')).toHaveLength(69);
    expect(text.endsWith(lastLine)).toBe(true);
    expect(lastLine.trimEnd().endsWith(LAST_DIRECTORY)).toBe(true);

    const projected = applyStaleBudget(text);
    expect(projected.endsWith(lastLine)).toBe(true);
    if (estimateTokens(text) <= 2000) {
      expect(projected).toBe(text);
    } else {
      expect(projected).toContain('...[truncated]...');
    }
  });

  it('keeps the last line when the same listing shape exceeds 2000 tokens', () => {
    const { entryLines, lastLine } = buildSixtyNineLineListing();
    const text = listingOverTokens(entryLines, lastLine, 2000);
    expect(estimateTokens(text)).toBeGreaterThan(2000);
    expect(text.endsWith(lastLine)).toBe(true);

    const projected = applyStaleBudget(text);
    expect(projected.endsWith(lastLine)).toBe(true);
    expect(projected).toContain('...[truncated]...');
    expect(projected).not.toBe(text);
  });

  it('keeps the last line through bash truncation at 30000 chars', () => {
    expect(BASH.MAX_OUTPUT_LENGTH).toBe(30000);
    const { text, lastLine } = buildSixtyNineLineListing();
    const unit = `${text}\n`;
    let wide = unit;
    while (wide.length < 40000) wide += unit;
    expect(wide.length).toBeGreaterThanOrEqual(40000);
    expect(wide.endsWith(lastLine) || wide.endsWith(`${lastLine}\n`)).toBe(true);

    const truncated = truncateMiddleErrorAware(wide, BASH.MAX_OUTPUT_LENGTH);
    expect(truncated.length).toBeLessThan(wide.length);
    expect(truncated.endsWith(lastLine) || truncated.endsWith(`${lastLine}\n`)).toBe(true);
  });

  it.each(WINDOW_TIERS)(
    'keeps the last line at the L1 budget for a %s-token window',
    (windowTokens) => {
      const l1MaxTokens = resolveToolResultBudget(windowTokens).l1MaxTokens;
      const { entryLines, lastLine } = buildSixtyNineLineListing();
      const text = listingOverTokens(entryLines, lastLine, l1MaxTokens);
      expect(estimateTokens(text)).toBeGreaterThan(l1MaxTokens);
      expect(text.endsWith(lastLine)).toBe(true);

      const projected = applyStaleBudget(text, l1MaxTokens);
      expect(projected.endsWith(lastLine)).toBe(true);
      expect(projected).toContain('...[truncated]...');
      expect(projected).not.toBe(text);
    },
  );

  it.each(WINDOW_TIERS)(
    'keeps the last line through bash truncation at the %s-token window cap',
    (windowTokens) => {
      // bash.ts feeds resolveToolResultBudget(...).maxOutputChars to truncateMiddleErrorAware.
      const maxOutputChars = resolveToolResultBudget(windowTokens).maxOutputChars;
      const { text, lastLine } = buildSixtyNineLineListing();
      const wide = listingOverChars(text, maxOutputChars);
      expect(wide.length).toBeGreaterThan(maxOutputChars);
      expect(wide.endsWith(`${lastLine}\n`)).toBe(true);

      const truncated = truncateMiddleErrorAware(wide, maxOutputChars);
      expect(truncated.length).toBeLessThan(wide.length);
      expect(truncated.endsWith(lastLine) || truncated.endsWith(`${lastLine}\n`)).toBe(true);
    },
  );

  it('archives a result above 4096 tokens and previews only the head', () => {
    expect(ACTIVE_TOOL_RESULT_PRUNE.MAX_TOKENS_PER_RESULT).toBe(4096);
    const { lastLine, entryLines } = buildSixtyNineLineListing();
    const original = listingOverTokens(entryLines, lastLine, ACTIVE_TOOL_RESULT_PRUNE.MAX_TOKENS_PER_RESULT);
    expectArchivedHeadPreview(
      original,
      lastLine,
      ACTIVE_TOOL_RESULT_PRUNE.MAX_TOKENS_PER_RESULT,
      'ls-tail',
    );
  });

  it.each(WINDOW_TIERS)(
    'archives a result above the L0 budget for a %s-token window and previews only the head',
    (windowTokens) => {
      const l0MaxTokens = resolveToolResultBudget(windowTokens).l0MaxTokens;
      const { entryLines, lastLine } = buildSixtyNineLineListing();
      const original = listingOverTokens(entryLines, lastLine, l0MaxTokens);
      expectArchivedHeadPreview(original, lastLine, l0MaxTokens, `ls-tail-l0-${windowTokens}`);
    },
  );
});

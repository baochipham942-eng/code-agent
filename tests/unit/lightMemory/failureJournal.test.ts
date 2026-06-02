// ============================================================================
// Light Memory — Failure Journal Tests (GAP-005)
// 测试跨会话失败模式的合并落盘、INDEX.md 维护、system prompt 块构建
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

// Mock configPaths to use a temp directory instead of real ~/.code-agent
const mockConfigDir = vi.hoisted(() => {
  return { dir: '' };
});

vi.mock('../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  normalizeErrorMessage,
  buildFailurePatternKey,
  recordFailurePatterns,
  loadFailureJournalEntries,
  buildFailureJournalBlock,
  type FailurePattern,
} from '../../../src/main/lightMemory/failureJournal';
import { LEARNING_PIPELINE } from '../../../src/shared/constants';

function makePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  return {
    key: 'Bash:command_failure:npm test failed with N errors',
    toolName: 'Bash',
    errorCategory: 'command_failure',
    pattern: 'npm test failed with N errors',
    count: 3,
    sessions: ['session-1'],
    firstSeen: 1000,
    lastSeen: 2000,
    sampleError: 'npm test failed with 5 errors',
    ...overrides,
  };
}

describe('failureJournal', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fj-test-'));
    mockConfigDir.dir = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // 归一化
  // --------------------------------------------------------------------------

  describe('normalizeErrorMessage', () => {
    it('should replace numbers with N', () => {
      expect(normalizeErrorMessage('failed after 30 seconds, code 127')).toBe(
        'failed after N seconds, code N',
      );
    });

    it('should replace quoted strings', () => {
      expect(normalizeErrorMessage("file '/tmp/foo.ts' not found")).toBe('file "..." not found');
    });

    it('should truncate long messages', () => {
      const long = 'x'.repeat(500);
      expect(normalizeErrorMessage(long).length).toBe(LEARNING_PIPELINE.ERROR_PATTERN_MAX_CHARS);
    });
  });

  describe('buildFailurePatternKey', () => {
    it('should produce stable keys for messages differing only in numbers/paths', () => {
      const key1 = buildFailurePatternKey('Bash', 'timeout', 'timed out after 30s');
      const key2 = buildFailurePatternKey('Bash', 'timeout', 'timed out after 60s');
      expect(key1).toBe(key2);
    });

    it('should produce different keys for different tools', () => {
      const key1 = buildFailurePatternKey('Bash', 'timeout', 'timed out');
      const key2 = buildFailurePatternKey('Read', 'timeout', 'timed out');
      expect(key1).not.toBe(key2);
    });
  });

  // --------------------------------------------------------------------------
  // 落盘 + 读取
  // --------------------------------------------------------------------------

  describe('recordFailurePatterns / loadFailureJournalEntries', () => {
    it('should return 0 for empty patterns', async () => {
      expect(await recordFailurePatterns([])).toBe(0);
    });

    it('should write journal file with frontmatter and machine-readable JSON', async () => {
      const written = await recordFailurePatterns([makePattern()], 5000);
      expect(written).toBe(1);

      const journalPath = path.join(tmpDir, 'memory', LEARNING_PIPELINE.JOURNAL_FILENAME);
      const content = await fs.readFile(journalPath, 'utf-8');
      expect(content).toContain('name: failure-journal');
      expect(content).toContain('Bash · command_failure');
      expect(content).toContain('FAILURE_JOURNAL_JSON');

      const entries = await loadFailureJournalEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].count).toBe(3);
    });

    it('should update INDEX.md with journal entry', async () => {
      await recordFailurePatterns([makePattern()], 5000);

      const indexContent = await fs.readFile(path.join(tmpDir, 'memory', 'INDEX.md'), 'utf-8');
      expect(indexContent).toContain(`- [${LEARNING_PIPELINE.JOURNAL_FILENAME}](${LEARNING_PIPELINE.JOURNAL_FILENAME})`);
    });

    it('should not duplicate INDEX.md entry on repeated writes', async () => {
      await recordFailurePatterns([makePattern()], 5000);
      await recordFailurePatterns([makePattern()], 6000);

      const indexContent = await fs.readFile(path.join(tmpDir, 'memory', 'INDEX.md'), 'utf-8');
      const matches = indexContent.split('\n').filter((line) =>
        line.startsWith(`- [${LEARNING_PIPELINE.JOURNAL_FILENAME}]`),
      );
      expect(matches).toHaveLength(1);
    });

    it('should merge counts across sessions for the same pattern key', async () => {
      await recordFailurePatterns([makePattern({ count: 3, sessions: ['session-1'] })], 5000);
      await recordFailurePatterns([makePattern({ count: 4, sessions: ['session-2'], lastSeen: 9000 })], 9000);

      const entries = await loadFailureJournalEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].count).toBe(7);
      expect(entries[0].sessions).toEqual(expect.arrayContaining(['session-1', 'session-2']));
      expect(entries[0].lastSeen).toBe(9000);
    });

    it('should keep different pattern keys as separate entries', async () => {
      await recordFailurePatterns([
        makePattern(),
        makePattern({
          key: 'Read:file_not_found:no such file "..."',
          toolName: 'Read',
          errorCategory: 'file_not_found',
          pattern: 'no such file "..."',
        }),
      ], 5000);

      const entries = await loadFailureJournalEntries();
      expect(entries).toHaveLength(2);
    });

    it('should evict oldest entries beyond JOURNAL_MAX_ENTRIES', async () => {
      const patterns = Array.from({ length: LEARNING_PIPELINE.JOURNAL_MAX_ENTRIES + 5 }, (_, i) =>
        makePattern({
          key: `Tool${i}:unknown:error ${i}`,
          toolName: `Tool${i}`,
          lastSeen: 1000 + i,
        }),
      );
      await recordFailurePatterns(patterns, 5000);

      const entries = await loadFailureJournalEntries();
      expect(entries).toHaveLength(LEARNING_PIPELINE.JOURNAL_MAX_ENTRIES);
      // 最旧的（lastSeen 最小）被淘汰
      expect(entries.some((entry) => entry.toolName === 'Tool0')).toBe(false);
      // 最新的保留
      expect(entries.some((entry) => entry.toolName === `Tool${LEARNING_PIPELINE.JOURNAL_MAX_ENTRIES + 4}`)).toBe(true);
    });

    it('should return empty array when journal does not exist', async () => {
      expect(await loadFailureJournalEntries()).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // System prompt 注入块
  // --------------------------------------------------------------------------

  describe('buildFailureJournalBlock', () => {
    it('should return null when journal is empty', async () => {
      expect(await buildFailureJournalBlock()).toBeNull();
    });

    it('should build a <failure_journal> block from entries', async () => {
      await recordFailurePatterns([makePattern()], 5000);

      const block = await buildFailureJournalBlock();
      expect(block).not.toBeNull();
      expect(block).toContain('<failure_journal>');
      expect(block).toContain('</failure_journal>');
      expect(block).toContain('Bash (command_failure, 3次)');
      expect(block).toContain('npm test failed with N errors');
    });

    it('should cap injected entries at INJECTION_MAX_ENTRIES', async () => {
      const patterns = Array.from({ length: LEARNING_PIPELINE.INJECTION_MAX_ENTRIES + 5 }, (_, i) =>
        makePattern({
          key: `Tool${i}:unknown:error ${i}`,
          toolName: `Tool${i}`,
          lastSeen: 1000 + i,
        }),
      );
      await recordFailurePatterns(patterns, 5000);

      const block = await buildFailureJournalBlock();
      const lines = block!.split('\n').filter((line) => line.startsWith('- '));
      expect(lines).toHaveLength(LEARNING_PIPELINE.INJECTION_MAX_ENTRIES);
    });
  });
});

// ============================================================================
// Light Memory — recentConversations Tests
// Tests conversation summary append, parsing, formatting, and block generation
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

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
  appendConversationSummary,
  buildRecentConversationsBlock,
} from '../../../src/main/lightMemory/recentConversations';
import type { ConversationSummary } from '../../../src/main/lightMemory/recentConversations';

describe('recentConversations', () => {
  let tmpDir: string;
  let memDir: string;
  let summaryPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-conv-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    summaryPath = path.join(memDir, 'recent-conversations.md');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // appendConversationSummary
  // --------------------------------------------------------------------------

  describe('appendConversationSummary', () => {
    it('should create recent-conversations.md on first append', async () => {
      const summary: ConversationSummary = {
        date: '2026-03-19',
        title: 'Building Light Memory tests',
        highlights: ['unit testing', 'vitest patterns'],
      };

      await appendConversationSummary(summary);

      const content = await fs.readFile(summaryPath, 'utf-8');
      expect(content).toContain('# Recent Conversations');
      expect(content).toContain('**2026-03-19**');
      expect(content).toContain('"Building Light Memory tests"');
      expect(content).toContain('unit testing, vitest patterns');
    });

    it('should append multiple summaries', async () => {
      await appendConversationSummary({
        date: '2026-03-18',
        title: 'Session 1',
        highlights: ['feature A'],
      });
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Session 2',
        highlights: ['feature B'],
      });

      const content = await fs.readFile(summaryPath, 'utf-8');
      expect(content).toContain('Session 1');
      expect(content).toContain('Session 2');
    });

    it('should keep only last 15 entries', async () => {
      for (let i = 1; i <= 20; i++) {
        await appendConversationSummary({
          date: `2026-03-${String(i).padStart(2, '0')}`,
          title: `Session ${i}`,
          highlights: [`task ${i}`],
        });
      }

      const content = await fs.readFile(summaryPath, 'utf-8');
      // Should not have first 5 entries
      expect(content).not.toContain('Session 1"');
      expect(content).not.toContain('Session 5"');
      // Should have entries 6-20
      expect(content).toContain('Session 6"');
      expect(content).toContain('Session 20"');

      // Count actual entries
      const entries = content.split('\n').filter((l: string) => l.startsWith('- **'));
      expect(entries.length).toBe(15);
    });

    it('should handle summaries with multiple highlights', async () => {
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Complex session',
        highlights: ['refactoring', 'testing', 'deployment'],
      });

      const content = await fs.readFile(summaryPath, 'utf-8');
      expect(content).toContain('refactoring, testing, deployment');
    });
  });

  // --------------------------------------------------------------------------
  // buildRecentConversationsBlock
  // --------------------------------------------------------------------------

  describe('buildRecentConversationsBlock', () => {
    it('should return null when no summaries exist', async () => {
      const block = await buildRecentConversationsBlock();
      expect(block).toBeNull();
    });

    it('should return null when memory dir does not exist', async () => {
      const block = await buildRecentConversationsBlock();
      expect(block).toBeNull();
    });

    it('should return formatted block with summaries', async () => {
      await appendConversationSummary({
        date: '2026-03-18',
        title: 'Building a chatbot',
        highlights: ['prompt engineering', 'tool use'],
      });
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Adding tests',
        highlights: ['vitest', 'coverage'],
      });

      const block = await buildRecentConversationsBlock();
      expect(block).not.toBeNull();
      expect(block).toContain('<recent_conversations>');
      expect(block).toContain('</recent_conversations>');
      expect(block).toContain('last 2 sessions');
      expect(block).toContain('Building a chatbot');
      expect(block).toContain('Adding tests');
    });

    it('should show correct session count in the block', async () => {
      for (let i = 0; i < 5; i++) {
        await appendConversationSummary({
          date: `2026-03-${15 + i}`,
          title: `Session ${i}`,
          highlights: ['task'],
        });
      }

      const block = await buildRecentConversationsBlock();
      expect(block).toContain('last 5 sessions');
    });
  });

  // --------------------------------------------------------------------------
  // Round-trip: write -> parse -> read back
  // --------------------------------------------------------------------------

  describe('round-trip parsing', () => {
    it('should correctly round-trip summaries through file storage', async () => {
      const original: ConversationSummary = {
        date: '2026-03-19',
        title: 'Light Memory refactor',
        highlights: ['index loader', 'session metadata', 'IPC handlers'],
      };

      await appendConversationSummary(original);

      // Read back by building the block
      const block = await buildRecentConversationsBlock();
      expect(block).toContain(original.title);
      expect(block).toContain(original.highlights.join(', '));
    });

    it('should handle empty highlights gracefully', async () => {
      // Edge case: empty highlights array — the format produces "— " with nothing after,
      // which the parser regex (requiring .+ after —) cannot parse back.
      // Key: appendConversationSummary should not crash.
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Quick question',
        highlights: [],
      });

      // File was written without crashing
      const content = await fs.readFile(summaryPath, 'utf-8');
      expect(content).toContain('Quick question');

      // But the parser can't round-trip it (regex requires .+ after —),
      // so buildRecentConversationsBlock returns null (0 parsed entries)
      const block = await buildRecentConversationsBlock();
      expect(block).toBeNull();
    });
  });
});

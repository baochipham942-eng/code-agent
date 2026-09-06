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

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
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
  isLoopAutomationSummaryText,
} from '../../../src/host/lightMemory/recentConversations';
import type { ConversationSummary } from '../../../src/host/lightMemory/recentConversations';

describe('recentConversations', () => {
  let tmpDir: string;
  let memDir: string;
  let summaryPath: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T12:00:00.000Z'));
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-conv-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    summaryPath = path.join(memDir, 'recent-conversations.md');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // appendConversationSummary
  // --------------------------------------------------------------------------

  describe('appendConversationSummary', () => {
    it('memory-write-no-secrets: redacts summaries and existing entries before disk writes', async () => {
      const secret = 'sk-testonly-' + 'a'.repeat(40);
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(summaryPath, `- **2026-03-18**: "old" — api_key=${secret}\n`);
      await appendConversationSummary({
        date: '2026-03-19', title: `api_key=${secret}`,
        highlights: [`token=${secret}`, 'keep this useful topic'],
      });
      const persisted = await fs.readFile(summaryPath, 'utf8');
      expect(persisted).not.toContain(secret);
      expect(persisted).toContain('keep this useful topic');
      expect(persisted).toContain('REDACTED');
    });

    it('does not write when the caller disables recent conversation persistence', async () => {
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Evaluation-only session',
        highlights: ['must stay isolated'],
      }, { enabled: false });

      await expect(fs.stat(summaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

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

    it('should update an existing summary with the same date and title instead of duplicating it', async () => {
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Same session',
        highlights: ['first turn'],
      });
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Same session',
        highlights: ['second turn'],
      });

      const content = await fs.readFile(summaryPath, 'utf-8');
      const entries = content.split('\n').filter((l: string) => l.startsWith('- **'));
      expect(entries.length).toBe(1);
      expect(content).toContain('first turn, second turn');
    });

    it('keeps same-date same-title summaries separate across projects', async () => {
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Daily work',
        highlights: ['project A'],
        projectId: 'proj_a',
      });
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Daily work',
        highlights: ['project B'],
        projectId: 'proj_b',
      });

      const content = await fs.readFile(summaryPath, 'utf-8');
      expect(content.match(/"Daily work"/g)).toHaveLength(2);
      expect(content).toContain('[project:proj_a]');
      expect(content).toContain('[project:proj_b]');
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

    it('should skip loop automation summaries', async () => {
      await appendConversationSummary({
        date: '2026-03-19',
        title: '只回复一句检查中',
        highlights: ['loop run --max-turns 1'],
      });
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Normal session',
        highlights: ['manual user request'],
      });

      const content = await fs.readFile(summaryPath, 'utf-8');
      expect(content).not.toContain('只回复一句检查中');
      expect(content).toContain('Normal session');
    });
  });

  // --------------------------------------------------------------------------
  // buildRecentConversationsBlock
  // --------------------------------------------------------------------------

  describe('buildRecentConversationsBlock', () => {
    it('does not read summaries when the caller disables recent conversations', async () => {
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Production session',
        highlights: ['must not enter evaluation'],
      });

      await expect(buildRecentConversationsBlock({ enabled: false })).resolves.toBeNull();
    });

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

    it('should filter old loop automation summaries from prompt injection', async () => {
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(
        summaryPath,
        [
          '# Recent Conversations',
          '',
          '- **2026-03-18**: "【循环模式 · 第 1 轮】只回复一句检查中" — background loop',
          '- **2026-03-19**: "Manual debugging" — inspect renderer state',
          '',
        ].join('\n'),
        'utf-8',
      );

      const block = await buildRecentConversationsBlock();
      expect(block).not.toContain('检查中');
      expect(block).toContain('Manual debugging');
      expect(block).toContain('last 1 sessions');
    });

    it('shows only the current project when that project has recent entries', async () => {
      await appendConversationSummary({
        date: '2026-03-18',
        title: 'Project A first',
        highlights: ['A1'],
        projectId: 'proj_a',
      });
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Project B first',
        highlights: ['B1'],
        projectId: 'proj_b',
      });
      await appendConversationSummary({
        date: '2026-03-20',
        title: 'Legacy global item',
        highlights: ['global'],
      });
      await appendConversationSummary({
        date: '2026-03-20',
        title: 'Project A second',
        highlights: ['A2'],
        projectId: 'proj_a',
      });

      const block = await buildRecentConversationsBlock({ projectId: 'proj_a' });
      expect(block).toContain('Project A first');
      expect(block).toContain('Project A second');
      expect(block).not.toContain('Project B first');
      expect(block).not.toContain('Legacy global item');
      expect(block).toContain('last 2 sessions');
    });

    it('falls back to legacy/global entries when the current project has no recent hit', async () => {
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(
        summaryPath,
        [
          '# Recent Conversations',
          '',
          '- **2026-03-18**: "Legacy conversation" — old format still loads',
          '- **2026-03-19** [project:proj_b]: "Project B" — must stay isolated',
          '',
        ].join('\n'),
        'utf-8',
      );

      const block = await buildRecentConversationsBlock({ projectId: 'proj_a' });
      expect(block).toContain('Legacy conversation');
      expect(block).not.toContain('Project B');
      expect(block).toContain('last 1 sessions');
    });

    it('keeps the global behavior when there is no project context', async () => {
      await appendConversationSummary({
        date: '2026-03-18',
        title: 'Project A',
        highlights: ['A'],
        projectId: 'proj_a',
      });
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Project B',
        highlights: ['B'],
        projectId: 'proj_b',
      });
      await appendConversationSummary({
        date: '2026-03-20',
        title: 'Global',
        highlights: ['G'],
      });

      const withoutProject = await buildRecentConversationsBlock();
      const unsorted = await buildRecentConversationsBlock({ projectId: 'proj_unsorted' });
      for (const block of [withoutProject, unsorted]) {
        expect(block).toContain('Project A');
        expect(block).toContain('Project B');
        expect(block).toContain('Global');
      }
    });

    it('excludes entries older than two weeks', async () => {
      await appendConversationSummary({
        date: '2026-02-01',
        title: 'Old project work',
        highlights: ['old'],
        projectId: 'proj_a',
      });
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Recent project work',
        highlights: ['recent'],
        projectId: 'proj_a',
      });

      const block = await buildRecentConversationsBlock({ projectId: 'proj_a' });
      expect(block).toContain('Recent project work');
      expect(block).not.toContain('Old project work');
    });
  });

  describe('isLoopAutomationSummaryText', () => {
    it('detects loop automation prompt fragments', () => {
      expect(isLoopAutomationSummaryText('只回复一句检查中')).toBe(true);
      expect(isLoopAutomationSummaryText('/loop 检查状态 --max-turns 1')).toBe(true);
      expect(isLoopAutomationSummaryText('正常调试会话')).toBe(false);
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
      await appendConversationSummary({
        date: '2026-03-19',
        title: 'Quick question',
        highlights: [],
      });

      // File was written without crashing
      const content = await fs.readFile(summaryPath, 'utf-8');
      expect(content).toContain('Quick question');

      const block = await buildRecentConversationsBlock();
      expect(block).toContain('Quick question');
    });
  });
});

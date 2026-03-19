// ============================================================================
// Light Memory — sessionMetadata Tests
// Tests session tracking, stats persistence, and metadata block generation
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
  recordSessionStart,
  recordSessionEnd,
  buildSessionMetadataBlock,
} from '../../../src/main/lightMemory/sessionMetadata';

describe('sessionMetadata', () => {
  let tmpDir: string;
  let memDir: string;
  let statsPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-session-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    statsPath = path.join(memDir, 'session-stats.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Helper to read stats file
  async function readStats() {
    const raw = await fs.readFile(statsPath, 'utf-8');
    return JSON.parse(raw);
  }

  // --------------------------------------------------------------------------
  // recordSessionStart
  // --------------------------------------------------------------------------

  describe('recordSessionStart', () => {
    it('should create session-stats.json on first call', async () => {
      await recordSessionStart();

      const stats = await readStats();
      expect(stats.totalSessions).toBe(1);
      expect(stats.activeDays.length).toBe(1);
      expect(stats.lastSessionStart).toBeTruthy();
    });

    it('should increment totalSessions on each call', async () => {
      await recordSessionStart();
      await recordSessionStart();
      await recordSessionStart();

      const stats = await readStats();
      expect(stats.totalSessions).toBe(3);
    });

    it('should add today to activeDays (deduplicated)', async () => {
      await recordSessionStart();
      await recordSessionStart();

      const stats = await readStats();
      const today = new Date().toISOString().split('T')[0];
      const todayEntries = stats.activeDays.filter((d: string) => d === today);
      expect(todayEntries.length).toBe(1);
    });

    it('should trim activeDays older than 30 days', async () => {
      // Pre-seed with old dates
      await fs.mkdir(memDir, { recursive: true });
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 60);
      const oldDateStr = oldDate.toISOString().split('T')[0];

      await fs.writeFile(statsPath, JSON.stringify({
        activeDays: [oldDateStr],
        totalSessions: 5,
        recentSessionDepths: [],
        modelUsage: {},
        lastSessionStart: '',
      }), 'utf-8');

      await recordSessionStart();

      const stats = await readStats();
      expect(stats.activeDays).not.toContain(oldDateStr);
      expect(stats.totalSessions).toBe(6);
    });
  });

  // --------------------------------------------------------------------------
  // recordSessionEnd
  // --------------------------------------------------------------------------

  describe('recordSessionEnd', () => {
    it('should record message count in recentSessionDepths', async () => {
      await recordSessionEnd(25);

      const stats = await readStats();
      expect(stats.recentSessionDepths).toContain(25);
    });

    it('should track model usage counts', async () => {
      await recordSessionEnd(10, 'kimi-k2.5');
      await recordSessionEnd(15, 'kimi-k2.5');
      await recordSessionEnd(8, 'deepseek-chat');

      const stats = await readStats();
      expect(stats.modelUsage['kimi-k2.5']).toBe(2);
      expect(stats.modelUsage['deepseek-chat']).toBe(1);
    });

    it('should keep only last 15 session depths', async () => {
      for (let i = 0; i < 20; i++) {
        await recordSessionEnd(i + 1);
      }

      const stats = await readStats();
      expect(stats.recentSessionDepths.length).toBe(15);
      // Should have the last 15 entries (6-20)
      expect(stats.recentSessionDepths[0]).toBe(6);
      expect(stats.recentSessionDepths[14]).toBe(20);
    });

    it('should not record model usage when model is undefined', async () => {
      await recordSessionEnd(10);

      const stats = await readStats();
      expect(Object.keys(stats.modelUsage).length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // buildSessionMetadataBlock
  // --------------------------------------------------------------------------

  describe('buildSessionMetadataBlock', () => {
    it('should return null when no stats exist', async () => {
      const block = await buildSessionMetadataBlock();
      expect(block).toBeNull();
    });

    it('should return null when totalSessions is 0', async () => {
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(statsPath, JSON.stringify({
        activeDays: [],
        totalSessions: 0,
        recentSessionDepths: [],
        modelUsage: {},
        lastSessionStart: '',
      }), 'utf-8');

      const block = await buildSessionMetadataBlock();
      expect(block).toBeNull();
    });

    it('should return formatted metadata block with session data', async () => {
      await recordSessionStart();
      await recordSessionEnd(20, 'kimi-k2.5');

      const block = await buildSessionMetadataBlock();
      expect(block).not.toBeNull();
      expect(block).toContain('<session_metadata>');
      expect(block).toContain('</session_metadata>');
      expect(block).toContain('Total sessions:');
      expect(block).toContain('Avg conversation depth:');
      expect(block).toContain('Model distribution:');
    });

    it('should show correct model distribution percentages', async () => {
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(statsPath, JSON.stringify({
        activeDays: ['2026-03-19'],
        totalSessions: 10,
        recentSessionDepths: [10, 20],
        modelUsage: { 'kimi-k2.5': 7, 'deepseek-chat': 3 },
        lastSessionStart: new Date().toISOString(),
      }), 'utf-8');

      const block = await buildSessionMetadataBlock();
      expect(block).toContain('kimi-k2.5 70%');
      expect(block).toContain('deepseek-chat 30%');
    });

    it('should show top 3 models only', async () => {
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(statsPath, JSON.stringify({
        activeDays: ['2026-03-19'],
        totalSessions: 10,
        recentSessionDepths: [10],
        modelUsage: {
          'model-a': 10,
          'model-b': 5,
          'model-c': 3,
          'model-d': 2,
        },
        lastSessionStart: new Date().toISOString(),
      }), 'utf-8');

      const block = await buildSessionMetadataBlock();
      expect(block).toContain('model-a');
      expect(block).toContain('model-b');
      expect(block).toContain('model-c');
      expect(block).not.toContain('model-d');
    });

    it('should show N/A for avg depth when no session depths recorded', async () => {
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(statsPath, JSON.stringify({
        activeDays: ['2026-03-19'],
        totalSessions: 1,
        recentSessionDepths: [],
        modelUsage: {},
        lastSessionStart: new Date().toISOString(),
      }), 'utf-8');

      const block = await buildSessionMetadataBlock();
      expect(block).toContain('Avg conversation depth: N/A');
    });

    it('should calculate correct average depth', async () => {
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(statsPath, JSON.stringify({
        activeDays: ['2026-03-19'],
        totalSessions: 3,
        recentSessionDepths: [10, 20, 30],
        modelUsage: {},
        lastSessionStart: new Date().toISOString(),
      }), 'utf-8');

      const block = await buildSessionMetadataBlock();
      expect(block).toContain('Avg conversation depth: 20.0');
    });
  });
});

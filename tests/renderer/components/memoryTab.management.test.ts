import { describe, expect, it } from 'vitest';
import type {
  LightMemoryFile,
  LightMemoryStats,
} from '../../../src/renderer/components/features/settings/tabs/MemoryTab';
import type {
  MemoryExportV2Bundle,
  MemoryImportV2DryRunResult,
} from '../../../src/shared/contract/memory';
import {
  buildMemoryImportSummary,
  buildMemoryManagementRows,
  buildMemoryManagementSummary,
  formatMemoryUpdatedAt,
  getMemoryImportApplyCount,
  getMemoryTypeConfig,
  isMemoryExportV2Bundle,
} from '../../../src/renderer/components/features/settings/tabs/MemoryTab';

const now = new Date('2026-05-15T08:00:00.000Z');

const userMemory = {
  filename: 'user_profile.md',
  name: 'User Profile',
  description: 'Basic user preferences',
  type: 'user',
  content: '中文偏好，先说结论。',
  updatedAt: '2026-05-15T06:00:00.000Z',
} satisfies LightMemoryFile;

const projectMemory = {
  filename: 'code_agent.md',
  name: 'Agent Neo',
  description: 'Project context',
  type: 'project',
  content: 'Settings management surface',
  updatedAt: '2026-05-14T08:00:00.000Z',
} satisfies LightMemoryFile;

const stats = {
  totalFiles: 4,
  byType: {
    user: 1,
    project: 1,
  },
  sessionStats: {
    activeDays: ['2026-05-08', '2026-05-10', '2026-05-15'],
    totalSessions: 12,
    recentSessionDepths: [10, 20],
    modelUsage: {
      'gpt-5.5': 8,
    },
  },
  recentConversations: ['- Settings work'],
} satisfies LightMemoryStats;

const importBundle = {
  schemaVersion: 2,
  exportedAt: Date.parse('2026-05-15T07:00:00.000Z'),
  entries: [],
  index: {
    path: 'INDEX.md',
    content: '# Memory Index',
  },
  evidenceManifest: [],
  sourceCounts: {
    light_file: 1,
    db_memory: 0,
  },
} satisfies MemoryExportV2Bundle;

const importDryRun = {
  schemaVersion: 2,
  incomingCount: 5,
  existingCount: 3,
  added: 2,
  updated: 1,
  conflicted: 1,
  skipped: 1,
  items: [
    {
      entryId: 'mem_entry_new',
      status: 'add',
      reason: 'new entry',
      incomingTitle: 'New memory',
      sourceOfTruth: 'light_file',
    },
  ],
} satisfies MemoryImportV2DryRunResult;

describe('MemoryTab management helpers', () => {
  it('formats memory updated time for table rows', () => {
    expect(formatMemoryUpdatedAt('2026-05-15T00:00:00.000Z', now)).toBe('今天');
    expect(formatMemoryUpdatedAt('2026-05-14T08:00:00.000Z', now)).toBe('昨天');
    expect(formatMemoryUpdatedAt('2026-05-12T08:00:00.000Z', now)).toBe('3天前');
  });

  it('builds memory rows with type metadata and selected state', () => {
    const rows = buildMemoryManagementRows({
      files: [userMemory, projectMemory],
      selectedFilename: 'code_agent.md',
      now,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      filename: 'user_profile.md',
      typeLabel: '用户',
      updatedAtLabel: '今天',
      contentLength: userMemory.content.length,
      selected: false,
    });
    expect(rows[1]).toMatchObject({
      filename: 'code_agent.md',
      typeLabel: '项目',
      updatedAtLabel: '昨天',
      selected: true,
    });
  });

  it('builds memory summary from files and session stats', () => {
    expect(buildMemoryManagementSummary({
      files: [userMemory, projectMemory],
      filteredFiles: [projectMemory],
      stats,
      now,
    })).toEqual({
      totalFiles: 4,
      matchedFiles: 1,
      typeCount: 2,
      totalSessions: 12,
      averageDepth: '15',
      activeDays7: 3,
      recentConversationCount: 1,
    });
  });

  it('falls back unknown memory type metadata', () => {
    expect(getMemoryTypeConfig('missing')).toMatchObject({
      label: '未分类',
    });
  });

  it('recognizes memory export v2 bundles before import preview', () => {
    expect(isMemoryExportV2Bundle(importBundle)).toBe(true);
    expect(isMemoryExportV2Bundle({ ...importBundle, schemaVersion: 1 })).toBe(false);
    expect(isMemoryExportV2Bundle({ ...importBundle, entries: undefined })).toBe(false);
  });

  it('builds import preview summary and keeps conflicts opt-in', () => {
    expect(buildMemoryImportSummary(importDryRun)).toEqual([
      { status: 'add', label: '新增', value: 2, className: 'text-emerald-300' },
      { status: 'update', label: '更新', value: 1, className: 'text-sky-300' },
      { status: 'conflict', label: '冲突', value: 1, className: 'text-amber-300' },
      { status: 'skip', label: '跳过', value: 1, className: 'text-zinc-400' },
    ]);
    expect(getMemoryImportApplyCount(importDryRun, false)).toBe(3);
    expect(getMemoryImportApplyCount(importDryRun, true)).toBe(4);
  });
});

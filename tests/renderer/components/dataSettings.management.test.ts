import { describe, expect, it } from 'vitest';
import type {
  DataStats,
  SnapshotStats,
} from '../../../src/renderer/components/features/settings/tabs/DataSettings';
import {
  buildDataManagementRows,
  buildDataManagementSummary,
  formatDataSize,
  getRetentionLabel,
} from '../../../src/renderer/components/features/settings/tabs/DataSettings';

const dataStats = {
  sessionCount: 12,
  messageCount: 140,
  toolExecutionCount: 31,
  knowledgeCount: 4,
  databaseSize: 2 * 1024 * 1024,
  cacheEntries: 8,
} satisfies DataStats;

const snapshotStats = {
  snapshotCount: 6,
  sessionCount: 3,
  totalBytes: 1536,
  retentionDays: 7,
} satisfies SnapshotStats;

describe('DataSettings management helpers', () => {
  it('formats byte sizes for storage rows', () => {
    expect(formatDataSize(900)).toBe('900 B');
    expect(formatDataSize(1536)).toBe('1.5 KB');
    expect(formatDataSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('resolves retention labels', () => {
    expect(getRetentionLabel(7)).toBe('7 天');
    expect(getRetentionLabel(-1)).toBe('永久');
    expect(getRetentionLabel(999)).toBe('1 天');
  });

  it('builds management summary from data and snapshot stats', () => {
    expect(buildDataManagementSummary(dataStats, snapshotStats)).toEqual({
      sessionCount: 12,
      messageCount: 140,
      databaseSizeLabel: '2.0 MB',
      cacheEntries: 8,
      snapshotCount: 6,
      snapshotSizeLabel: '1.5 KB',
      retentionLabel: '7 天',
    });
  });

  it('builds table rows and marks cache as clearable', () => {
    const rows = buildDataManagementRows(dataStats);

    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      id: 'sessions',
      statusLabel: '保留',
      cleanupLabel: '不清理',
      action: 'none',
    });
    expect(rows[5]).toMatchObject({
      id: 'cache',
      valueLabel: '8 条',
      statusLabel: '可清理',
      statusTone: 'warning',
      action: 'clear-cache',
    });
  });

  it('falls back to zero stats when IPC data has not loaded', () => {
    expect(buildDataManagementSummary(null, null)).toMatchObject({
      sessionCount: 0,
      databaseSizeLabel: '0 B',
      snapshotCount: 0,
      retentionLabel: '1 天',
    });
    expect(buildDataManagementRows(null).find((row) => row.id === 'cache')).toMatchObject({
      valueLabel: '0 条',
      statusLabel: '干净',
      statusTone: 'stable',
    });
  });
});

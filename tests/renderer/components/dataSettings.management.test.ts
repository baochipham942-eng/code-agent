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
import { en, zh } from '../../../src/renderer/i18n';

const dataText = zh.settings.data;

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
    expect(getRetentionLabel(7, dataText.retentionOptions)).toBe(dataText.retentionOptions.sevenDays);
    expect(getRetentionLabel(-1, dataText.retentionOptions)).toBe(dataText.retentionOptions.forever);
    expect(getRetentionLabel(999, dataText.retentionOptions)).toBe(dataText.retentionOptions.oneDay);
  });

  it('builds management summary from data and snapshot stats', () => {
    expect(buildDataManagementSummary(dataStats, snapshotStats, dataText)).toEqual({
      sessionCount: 12,
      messageCount: 140,
      databaseSizeLabel: '2.0 MB',
      cacheEntries: 8,
      snapshotCount: 6,
      snapshotSizeLabel: '1.5 KB',
      retentionLabel: dataText.retentionOptions.sevenDays,
    });
  });

  it('builds table rows and marks cache as clearable', () => {
    const rows = buildDataManagementRows(dataStats, dataText);

    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      id: 'sessions',
      statusLabel: dataText.dataRows.sessions.status,
      cleanupLabel: dataText.dataRows.sessions.cleanup,
      action: 'none',
    });
    expect(rows[5]).toMatchObject({
      id: 'cache',
      valueLabel: `8${dataText.units.itemSuffix}`,
      statusLabel: dataText.dataRows.cache.statusClearable,
      statusTone: 'warning',
      cleanupLabel: dataText.dataRows.cache.cleanup,
      action: 'clear-cache',
    });
  });

  it('falls back to zero stats when IPC data has not loaded', () => {
    expect(buildDataManagementSummary(null, null, dataText)).toMatchObject({
      sessionCount: 0,
      databaseSizeLabel: '0 B',
      snapshotCount: 0,
      retentionLabel: dataText.retentionOptions.oneDay,
    });
    expect(buildDataManagementRows(null, dataText).find((row) => row.id === 'cache')).toMatchObject({
      valueLabel: `0${dataText.units.itemSuffix}`,
      statusLabel: dataText.dataRows.cache.statusClean,
      statusTone: 'stable',
    });
  });
});

describe('DataSettings telemetry health copy', () => {
  it('中文遥测健康文案指向会话 Replay，不再引用已删除的「内部评测」面板', () => {
    const copy = zh.settings.data.telemetry;

    expect(copy.title).toBe('Telemetry 健康');
    expect(copy.description).toBe('Agent 内部遥测的采集状态摘要。详细分析可从会话 Replay 查看。');
    expect(copy.description).not.toContain('内部评测');
  });

  it('keeps the English telemetry health copy in sync', () => {
    const copy = en.settings.data.telemetry;

    expect(copy.title).toBe('Telemetry health');
    expect(copy.description).toBe('Summary of internal agent telemetry collection. Use session Replay for detailed analysis.');
    expect(copy.description.toLowerCase()).not.toContain('internal eval');
  });
});

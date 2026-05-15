import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '../../../src/shared/contract/memory';
import {
  buildMemoryEntryRows,
  formatMemoryEntryUpdatedAt,
  getMemoryEntryKindLabel,
  getMemoryEntrySourceLabel,
  getMemoryEntryStatusLabel,
} from '../../../src/renderer/components/features/settings/tabs/MemoryEntriesManager';

const now = Date.parse('2026-05-15T08:00:00.000Z');

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'mem_entry_project',
    schemaVersion: 2,
    status: 'active',
    kind: 'project',
    scope: 'project',
    title: 'Project Memory',
    summary: 'Remember project rules',
    content: 'Use existing project patterns.',
    source: {
      kind: 'light_file',
      sourceOfTruth: 'light_file',
      filePath: 'project.md',
      label: 'Light Memory',
    },
    evidence: [{ filePath: 'project.md' }],
    projectPath: '/repo/code-agent',
    sessionId: null,
    confidence: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('MemoryEntriesManager helpers', () => {
  it('labels entry status, kind, source, and updated time', () => {
    expect(getMemoryEntryStatusLabel('archived')).toBe('归档');
    expect(getMemoryEntryKindLabel('pattern')).toBe('经验');
    expect(getMemoryEntrySourceLabel('db_memory')).toBe('DB memory');
    expect(formatMemoryEntryUpdatedAt(now, now)).toBe('今天');
    expect(formatMemoryEntryUpdatedAt(now - 24 * 60 * 60 * 1000, now)).toBe('昨天');
  });

  it('filters unified entries across query, status, kind, and source', () => {
    const light = entry({
      id: 'mem_entry_light',
      title: 'Light Rule',
      content: 'Light memory rule.',
      source: {
        kind: 'light_file',
        sourceOfTruth: 'light_file',
        filePath: 'light.md',
      },
    });
    const db = entry({
      id: 'mem_entry_db',
      status: 'archived',
      kind: 'pattern',
      title: 'DB Pattern',
      summary: 'Archive old pattern',
      content: 'DB memory pattern.',
      source: {
        kind: 'db_memory',
        sourceOfTruth: 'db_memory',
        memoryId: 'mem-db',
      },
    });

    expect(buildMemoryEntryRows({
      entries: [light, db],
      selectedEntryId: 'mem_entry_db',
      searchQuery: 'pattern',
      statusFilter: 'archived',
      kindFilter: 'pattern',
      sourceFilter: 'db_memory',
      now,
    })).toEqual([
      expect.objectContaining({
        id: 'mem_entry_db',
        title: 'DB Pattern',
        statusLabel: '归档',
        kindLabel: '经验',
        sourceLabel: 'DB memory',
        selected: true,
      }),
    ]);
  });
});

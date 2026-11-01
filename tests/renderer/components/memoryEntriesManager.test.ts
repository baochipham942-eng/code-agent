import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '../../../src/shared/contract/memory';
import {
  buildMemoryEntryRows,
  formatMemoryEntryUpdatedAt,
  getMemoryEntryKindLabel,
  getMemoryEntrySourceLabel,
  getMemoryEntryStatusLabel,
} from '../../../src/renderer/components/features/settings/tabs/MemoryEntriesManager';
import {
  findSourceSessionRef,
  formatBatchReviewSkippedDetail,
  visibleCandidateEntryIds,
} from '../../../src/renderer/components/features/settings/tabs/MemoryEntriesManager.helpers';
import { zh } from '../../../src/renderer/i18n/zh';

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
      showArchived: true,
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

    expect(buildMemoryEntryRows({
      entries: [light, db],
      selectedEntryId: null,
      searchQuery: '',
      statusFilter: 'all',
      showArchived: false,
      kindFilter: 'all',
      sourceFilter: 'all',
      now,
    }).map((row) => row.id)).toEqual(['mem_entry_light']);
  });

  it('marks entries whose auto-include is paused with a visible badge (N-MEM-EVICT-NEVER-READ)', () => {
    const paused = entry({ id: 'mem_paused', status: 'active', injectionPaused: { reason: 'never_used', since: now } });
    const normal = entry({ id: 'mem_normal', status: 'active' });
    const rows = buildMemoryEntryRows({
      entries: [paused, normal],
      selectedEntryId: null,
      searchQuery: '',
      statusFilter: 'all',
      kindFilter: 'all',
      sourceFilter: 'all',
      now,
    });
    expect(rows.find((row) => row.id === 'mem_paused')?.pausedLabel).toBe(zh.settings.memory.entries.injectionPaused.badge);
    expect(rows.find((row) => row.id === 'mem_normal')?.pausedLabel).toBeUndefined();
  });

  it('marks entries last changed by a background actor, not manual edits (N-MEM-JOURNAL-SOURCEJUMP)', () => {
    const background = entry({
      id: 'mem_bg',
      status: 'active',
      lastChange: { actor: 'dream', operation: 'update', timestamp: now },
    });
    const manual = entry({
      id: 'mem_manual',
      status: 'active',
      lastChange: { actor: 'user_manual', operation: 'update', timestamp: now },
    });
    const unjournaled = entry({ id: 'mem_no_journal', status: 'active' });
    const rows = buildMemoryEntryRows({
      entries: [background, manual, unjournaled],
      selectedEntryId: null,
      searchQuery: '',
      statusFilter: 'all',
      kindFilter: 'all',
      sourceFilter: 'all',
      now,
    });
    expect(rows.find((row) => row.id === 'mem_bg')?.backgroundWriteLabel).toBe(zh.settings.memory.entries.backgroundWriteBadge);
    expect(rows.find((row) => row.id === 'mem_manual')?.backgroundWriteLabel).toBeUndefined();
    expect(rows.find((row) => row.id === 'mem_no_journal')?.backgroundWriteLabel).toBeUndefined();
  });

  it('resolves the source session ref from the record column when evidence session ids are redacted (r3)', () => {
    // 落库链路把 evidence[].sessionId redact 成哨兵串；顶层 sessionId（记录列）保留原值
    expect(findSourceSessionRef(entry({
      sessionId: 'sess-a',
      evidence: [{ sessionId: '***REDACTED***', messageId: 'msg-1' }],
    }))).toEqual({ sessionId: 'sess-a', messageId: 'msg-1' });

    // 精确同会话的证据行优先于 redact 行
    expect(findSourceSessionRef(entry({
      sessionId: 'sess-a',
      evidence: [
        { sessionId: '***REDACTED***', messageId: 'msg-fallback' },
        { sessionId: 'sess-a', messageId: 'msg-exact' },
      ],
    }))).toEqual({ sessionId: 'sess-a', messageId: 'msg-exact' });

    // 明确来自别的会话的证据行跳过；sessionId 缺失（无 metadata 证据）也算不可证外来
    expect(findSourceSessionRef(entry({
      sessionId: 'sess-a',
      evidence: [
        { sessionId: 'sess-other', messageId: 'msg-other' },
        { messageId: 'msg-2' },
      ],
    }))).toEqual({ sessionId: 'sess-a', messageId: 'msg-2' });

    // 全是外来会话证据行时不取 messageId（跳会话顶部，不误落到别人的消息）
    expect(findSourceSessionRef(entry({
      sessionId: 'sess-a',
      evidence: [{ sessionId: 'sess-other', messageId: 'msg-other' }],
    }))).toEqual({ sessionId: 'sess-a', messageId: null });

    // 无顶层 sessionId 时 redact 哨兵不得顶上来当会话 id（否则探测/禁用原因会展示垃圾串）
    expect(findSourceSessionRef(entry({
      sessionId: null,
      evidence: [{ sessionId: '***REDACTED***', messageId: 'msg-1' }],
    }))).toEqual({ sessionId: null, messageId: null });

    // 无 metadata 的存量条目：默认证据行带真实 sessionId，仍可作为来源会话
    expect(findSourceSessionRef(entry({
      sessionId: null,
      evidence: [{ sessionId: 'sess-b', messageId: 'msg-3' }],
    }))).toEqual({ sessionId: 'sess-b', messageId: 'msg-3' });

    expect(findSourceSessionRef(null)).toEqual({ sessionId: null, messageId: null });
  });

  it('directive candidates stay out of the batch-selectable set', () => {
    const normal = entry({ id: 'mem_candidate_user', status: 'candidate', kind: 'user' });
    const directive = entry({ id: 'mem_candidate_directive', status: 'candidate', kind: 'directive' });
    const stale = entry({ id: 'mem_stale', status: 'stale', kind: 'pattern' });
    const rows = buildMemoryEntryRows({
      entries: [normal, directive, stale],
      selectedEntryId: null,
      searchQuery: '',
      statusFilter: 'all',
      kindFilter: 'all',
      sourceFilter: 'all',
      now,
    });

    expect(visibleCandidateEntryIds([normal, directive, stale], rows)).toEqual(['mem_candidate_user']);
  });

  it('translates known skip reasons and lists skipped titles; unknown reasons pass through', () => {
    const directive = entry({ id: 'mem_candidate_directive', status: 'candidate', kind: 'directive', title: 'Always rebase' });
    const detail = formatBatchReviewSkippedDetail(
      [
        { entryId: 'mem_candidate_directive', reason: 'directive-requires-explicit-confirmation' },
        { entryId: 'mem_missing', reason: 'some-future-reason' },
      ],
      [directive],
      zh.settings.memory.entries.batchReview,
    );

    expect(detail).toContain('Always rebase');
    expect(detail).toContain('指令类条目');
    expect(detail).toContain('mem_missing');
    expect(detail).toContain('some-future-reason');
  });

});

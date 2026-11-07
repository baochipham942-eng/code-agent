import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecentExternalChatImportResult } from '../../../src/shared/contract/agentEngine';

const loggerMocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: loggerMocks.warn, error: vi.fn(), debug: vi.fn() }),
}));

import {
  listImportHistory,
  recordChatImportHistory,
  recordSkillsImportHistory,
} from '../../../src/host/externalImport/importHistory';

let tmpRoot: string;
let dataDir: string;
let ledgerPath: string;

beforeEach(async () => {
  loggerMocks.warn.mockReset();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'external-import-history-'));
  dataDir = path.join(tmpRoot, 'data');
  ledgerPath = path.join(dataDir, 'external-import-history.json');
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function chat(index: number, status: RecentExternalChatImportResult['status'] = 'imported'): RecentExternalChatImportResult {
  return {
    engine: 'claude_code',
    sourceSessionId: `session-${index}`,
    title: `Chat ${index}`,
    status,
    reason: `raw failure /private/source-${index}.jsonl`,
  };
}

describe('import history ledger', () => {
  it('round-trips grouped chat and skill entries newest first with an injected clock', async () => {
    await recordChatImportHistory([
      chat(1),
      { ...chat(2), engine: 'codex_cli', status: 'already_imported' },
    ], { now: () => 1000 });
    await recordSkillsImportHistory([
      { sourceId: 'codex', name: 'alpha', action: 'copied' },
      { sourceId: 'codex', name: 'beta', action: 'skipped', reason: 'target-name-exists' },
      { sourceId: 'cursor', name: 'gamma', action: 'skipped', reason: 'copy-failed', error: '/private/raw-reason' },
    ], { now: () => 2000 });

    const entries = await listImportHistory();
    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => [entry.at, entry.category, entry.source, entry.count])).toEqual([
      [2000, 'skills', 'codex', 1],
      [2000, 'skills', 'cursor', 0],
      [1000, 'chats', 'claude_code', 1],
      [1000, 'chats', 'codex_cli', 0],
    ]);
    expect(entries[0]).toMatchObject({
      trigger: 'manual',
      items: [
        { label: 'alpha', outcome: 'copied' },
        { label: 'beta', outcome: 'skipped' },
      ],
    });
    expect(entries[0].id).toEqual(expect.any(String));
    expect(await listImportHistory()).toEqual(entries);
    expect(JSON.parse(await fs.readFile(ledgerPath, 'utf8'))).toEqual({ version: 1, entries });
  });

  it('caps the ledger at 200 entries and each entry at 100 items, dropping oldest data', async () => {
    for (let index = 0; index < 201; index += 1) {
      await recordSkillsImportHistory([
        { sourceId: 'codex', name: `skill-${index}`, action: 'copied' },
      ], { now: () => index });
    }
    await recordChatImportHistory(Array.from({ length: 101 }, (_, index) => chat(index)), { now: () => 999 });

    const entries = await listImportHistory();
    expect(entries).toHaveLength(200);
    expect(entries[0].items).toHaveLength(100);
    expect(entries[0].items[0]).toEqual({ label: 'Chat 0', outcome: 'imported', sourceSessionId: 'session-0' });
    expect(entries[0].items.at(-1)).toEqual({ label: 'Chat 99', outcome: 'imported', sourceSessionId: 'session-99' });
    expect(entries.at(-1)?.items[0].label).toBe('skill-2');
    expect(entries.some((entry) => entry.items[0]?.label === 'skill-0')).toBe(false);
  });

  it('returns empty and warns for a corrupt file, then starts fresh on the next write', async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(ledgerPath, '{broken', 'utf8');

    await expect(listImportHistory()).resolves.toEqual([]);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('read failed'),
      expect.objectContaining({ reason: expect.any(String) }),
    );

    await recordSkillsImportHistory([{ sourceId: 'cursor', name: 'fresh', action: 'copied' }]);
    const raw = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].items).toEqual([{ label: 'fresh', outcome: 'copied' }]);
  });

  it('does not record an automatic run whose imported count is zero', async () => {
    await recordChatImportHistory([chat(1, 'already_imported')], { trigger: 'auto' });
    await recordSkillsImportHistory([
      { sourceId: 'codex', name: 'existing', action: 'skipped', reason: 'target-name-exists' },
    ], { trigger: 'auto' });

    await expect(listImportHistory()).resolves.toEqual([]);
    await expect(fs.stat(ledgerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records a manual run even when its imported count is zero', async () => {
    await recordChatImportHistory([chat(1, 'failed')], { trigger: 'manual', now: () => 1234 });

    const entries = await listImportHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      at: 1234,
      trigger: 'manual',
      count: 0,
      items: [{ label: 'Chat 1', outcome: 'failed' }],
    });
  });

  it('persists titles, names and outcomes only, never source paths or raw reason strings', async () => {
    await recordChatImportHistory([chat(1, 'failed')]);
    await recordSkillsImportHistory([
      { sourceId: 'codex', name: 'alpha', action: 'skipped', reason: 'copy-failed', error: '/private/copy-error' },
    ]);

    const raw = await fs.readFile(ledgerPath, 'utf8');
    expect(raw).not.toContain('/private/');
    expect(raw).not.toContain('raw failure');
    expect(raw).not.toContain('copy-failed');
    expect(raw).not.toContain('sourceSessionId');
    expect(raw).not.toContain('reason');
    expect(raw).not.toContain('error');
  });
});

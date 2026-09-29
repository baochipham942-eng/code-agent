import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

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
  packMemoryEntries,
  rebuildMemoryMirrorFromLightFiles,
  type MemoryEntryDatabase,
} from '../../../src/host/memory/memoryEntryRuntime';

/** 有状态假 DB：create/update 真的落到内存表，list 按 includeArchived 过滤，行为对齐 MemoryRepository。 */
function createStatefulDb(): MemoryEntryDatabase & { rows: MemoryRecord[] } {
  const rows: MemoryRecord[] = [];
  let seq = 0;
  return {
    rows,
    listMemories: (options) => rows.filter((row) => (
      options?.includeArchived || row.status !== 'archived'
    )),
    createMemory: (data) => {
      const next: MemoryRecord = {
        ...data,
        id: `mem-${++seq}`,
        accessCount: 0,
        createdAt: 1778666100000,
        updatedAt: 1778666100000,
      };
      rows.push(next);
      return next;
    },
    updateMemory: (id, updates) => {
      const row = rows.find((item) => item.id === id);
      if (!row) return null;
      Object.assign(row, updates);
      return row;
    },
  };
}

function lightFile(entryId: string, name: string, body: string): string {
  return `---
name: ${name}
description: ${name}
type: user
entry_id: ${entryId}
status: active
source: knowledge_inbox
schema_version: 2
---

${body}
`;
}

const KEEP_MARKER = 'KEEP-MARKER-仍然存在的偏好';
const GONE_MARKER = 'GONE-MARKER-已被用户删除的偏好';

describe('rebuildMemoryMirrorFromLightFiles 孤儿镜像行（N-MEM-MIRRORORPHAN）', () => {
  let tmpDir: string;
  let memDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-mirror-orphan-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function packedText(db: MemoryEntryDatabase): Promise<string> {
    const pack = await packMemoryEntries({ projectPath: '/repo/x', maxItems: 30 }, db);
    return pack.block;
  }

  async function seed(db: MemoryEntryDatabase): Promise<void> {
    await fs.writeFile(path.join(memDir, 'keep.md'), lightFile('mem_entry_keep', 'Keep', KEEP_MARKER), 'utf-8');
    await fs.writeFile(path.join(memDir, 'gone.md'), lightFile('mem_entry_gone', 'Gone', GONE_MARKER), 'utf-8');
    await rebuildMemoryMirrorFromLightFiles(db);
    const before = await packedText(db);
    expect(before).toContain(KEEP_MARKER);
    expect(before).toContain(GONE_MARKER);
  }

  it('删除文件后重建：被删记忆不再出现在注入内容里，且镜像行软归档而非硬删', async () => {
    const db = createStatefulDb();
    await seed(db);

    await fs.rm(path.join(memDir, 'gone.md'));
    const result = await rebuildMemoryMirrorFromLightFiles(db);

    const block = await packedText(db);
    expect(block).toContain(KEEP_MARKER);
    expect(block).not.toContain(GONE_MARKER);
    expect(result.removed).toBe(1);
    const orphan = db.rows.find((row) => row.content.includes(GONE_MARKER));
    expect(orphan?.status).toBe('archived');
  });

  it('重命名文件后重建：旧文件名对应的孤儿行不与新文件重复注入', async () => {
    const db = createStatefulDb();
    await seed(db);

    // 重命名 = 换文件名，同时 entry_id 也换（手动改名/复制场景，无法靠 entryId 对上旧行）
    await fs.rm(path.join(memDir, 'gone.md'));
    await fs.writeFile(
      path.join(memDir, 'renamed.md'),
      lightFile('mem_entry_renamed', 'Renamed', GONE_MARKER),
      'utf-8',
    );
    await rebuildMemoryMirrorFromLightFiles(db);

    const block = await packedText(db);
    const occurrences = block.split(GONE_MARKER).length - 1;
    expect(occurrences).toBe(1);
    expect(block).toContain('renamed.md');
    expect(block).not.toContain('gone.md');
  });

  it('文件仍在时重建不误归档', async () => {
    const db = createStatefulDb();
    await seed(db);

    const result = await rebuildMemoryMirrorFromLightFiles(db);

    expect(result.removed).toBe(0);
    expect(db.rows.every((row) => row.status !== 'archived')).toBe(true);
    const block = await packedText(db);
    expect(block).toContain(KEEP_MARKER);
    expect(block).toContain(GONE_MARKER);
  });
});

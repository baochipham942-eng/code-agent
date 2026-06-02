// ============================================================================
// SkillDraftQueue Tests (GAP-005)
// 测试 skill 草稿队列：入队去重、列表、确认入库、拒绝 ledger
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => {
  return { dir: '' };
});

vi.mock('../../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getSkillsDir: () => ({
    user: {
      new: path.join(mockConfigDir.dir, 'skills'),
      legacy: path.join(mockConfigDir.dir, 'skills-legacy'),
    },
  }),
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  enqueueSkillDraft,
  listSkillDrafts,
  confirmSkillDraft,
  rejectSkillDraft,
  getSkillDraftsDir,
  generateDraftSkillMd,
} from '../../../../src/main/services/skills/skillDraftQueue';
import { LEARNING_PIPELINE } from '../../../../src/shared/constants';

function makeDraftInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'grep-read-edit',
    description: '自动蒸馏的工作流：Grep → Read → Edit（成功 3 次）',
    patternKey: 'Grep → Read → Edit',
    toolSequence: ['Grep', 'Read', 'Edit'],
    occurrences: 3,
    sessionId: 'session-1',
    exampleSteps: [
      { toolName: 'Grep', args: { pattern: 'foo' } },
      { toolName: 'Read', args: { file_path: '/tmp/a.ts' } },
      { toolName: 'Edit', args: { file_path: '/tmp/a.ts' } },
    ],
    timestamp: 1717300000000,
    ...overrides,
  };
}

describe('skillDraftQueue', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdq-test-'));
    mockConfigDir.dir = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // 草稿生成
  // --------------------------------------------------------------------------

  describe('generateDraftSkillMd', () => {
    it('should generate SKILL.md with frontmatter and steps', () => {
      const input = makeDraftInput();
      const md = generateDraftSkillMd({
        name: input.name,
        description: input.description,
        toolSequence: input.toolSequence,
        occurrences: input.occurrences,
        sessionId: input.sessionId,
        exampleSteps: input.exampleSteps,
        createdAt: input.timestamp,
      });

      expect(md).toContain('name: grep-read-edit');
      expect(md).toContain('source: telemetry-distilled');
      expect(md).toContain('allowed-tools: "Grep,Read,Edit"');
      expect(md).toContain('1. `Grep`');
      expect(md).toContain('3. `Edit`');
    });
  });

  // --------------------------------------------------------------------------
  // 入队 + 列表
  // --------------------------------------------------------------------------

  describe('enqueueSkillDraft / listSkillDrafts', () => {
    it('should enqueue a draft and list it as pending', async () => {
      const meta = await enqueueSkillDraft(makeDraftInput());
      expect(meta).not.toBeNull();
      expect(meta!.status).toBe('pending');

      const drafts = await listSkillDrafts();
      expect(drafts).toHaveLength(1);
      expect(drafts[0].name).toBe('grep-read-edit');

      // SKILL.md 写在草稿目录里，不在 skills 目录（严禁自动入库）
      const draftSkillMd = path.join(getSkillDraftsDir(), meta!.id, 'SKILL.md');
      await expect(fs.access(draftSkillMd)).resolves.toBeUndefined();
      await expect(fs.access(path.join(tmpDir, 'skills'))).rejects.toThrow();
    });

    it('should put drafts dir outside the skills discovery path', () => {
      const draftsDir = getSkillDraftsDir();
      expect(draftsDir).toBe(path.join(tmpDir, LEARNING_PIPELINE.DRAFTS_DIR_NAME));
      expect(draftsDir.startsWith(path.join(tmpDir, 'skills'))).toBe(false);
    });

    it('should skip enqueue for duplicate patternKey already pending', async () => {
      const first = await enqueueSkillDraft(makeDraftInput());
      const second = await enqueueSkillDraft(makeDraftInput({ timestamp: 1717300001000 }));
      expect(first).not.toBeNull();
      expect(second).toBeNull();

      const drafts = await listSkillDrafts();
      expect(drafts).toHaveLength(1);
    });

    it('should return empty list when queue dir does not exist', async () => {
      expect(await listSkillDrafts()).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // 确认入库
  // --------------------------------------------------------------------------

  describe('confirmSkillDraft', () => {
    it('should move SKILL.md into user skills dir and remove draft', async () => {
      const meta = await enqueueSkillDraft(makeDraftInput());
      const result = await confirmSkillDraft(meta!.id);

      expect(result.success).toBe(true);
      expect(result.skillPath).toBe(path.join(tmpDir, 'skills', 'grep-read-edit', 'SKILL.md'));

      const installed = await fs.readFile(result.skillPath!, 'utf-8');
      expect(installed).toContain('name: grep-read-edit');

      // 草稿目录被清掉
      const drafts = await listSkillDrafts();
      expect(drafts).toHaveLength(0);
    });

    it('should fail for unknown draft id', async () => {
      const result = await confirmSkillDraft('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // --------------------------------------------------------------------------
  // 拒绝 + ledger
  // --------------------------------------------------------------------------

  describe('rejectSkillDraft', () => {
    it('should delete draft and never re-enqueue the same patternKey', async () => {
      const meta = await enqueueSkillDraft(makeDraftInput());
      const result = await rejectSkillDraft(meta!.id);
      expect(result.success).toBe(true);

      expect(await listSkillDrafts()).toHaveLength(0);

      // 同一模式不再入队
      const again = await enqueueSkillDraft(makeDraftInput({ timestamp: 1717300002000 }));
      expect(again).toBeNull();

      // skills 目录始终没有被写入
      await expect(fs.access(path.join(tmpDir, 'skills'))).rejects.toThrow();
    });

    it('should fail for unknown draft id', async () => {
      const result = await rejectSkillDraft('nonexistent');
      expect(result.success).toBe(false);
    });
  });
});

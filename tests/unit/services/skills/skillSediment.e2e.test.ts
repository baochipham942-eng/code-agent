// ============================================================================
// Skill 自沉淀端到端集成测试
// 用真 fs + 真安全闸（不 mock skillContentGuard / commandSafety / sensitiveDetector），
// 跑通 enqueue(LLM body) → confirm → 安全扫描 → 落 skills 目录 整条链，
// 证明各片拼起来不散：origin/body 写入正确、fail-closed 安全闸真生效。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

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
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  enqueueSkillDraft,
  confirmSkillDraft,
  listSkillDrafts,
} from '../../../../src/main/services/skills/skillDraftQueue';

beforeEach(async () => {
  mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-sediment-'));
});

afterEach(async () => {
  await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
});

describe('运行时 skill 自沉淀端到端', () => {
  it('LLM 复盘草稿 → 确认 → 落 skills 目录（origin=llm-review + 语义正文）', async () => {
    const draft = await enqueueSkillDraft({
      name: 'deploy-tauri-macos',
      description: '部署 Tauri 桌面应用的标准流程',
      patternKey: 'llm-review:deploy-tauri-macos',
      origin: 'llm-review',
      body: '## 要点\n- 先 `npm run typecheck`\n- 用 `scripts/tauri-install.sh` 安装，别手动 cp',
      sessionId: 'sess-1',
    });
    expect(draft).not.toBeNull();
    expect(draft!.origin).toBe('llm-review');
    expect(draft!.toolSequence).toEqual([]);

    const result = await confirmSkillDraft(draft!.id);
    expect(result.success).toBe(true);

    const installed = await fs.readFile(
      path.join(mockConfigDir.dir, 'skills', 'deploy-tauri-macos', 'SKILL.md'),
      'utf-8',
    );
    expect(installed).toContain('source: llm-review');
    expect(installed).toContain('scripts/tauri-install.sh');
    // 草稿确认后应从队列移除
    expect(await listSkillDrafts()).toHaveLength(0);
  });

  it('含 critical 危险命令的草稿 → 安全闸拒绝入库（fail-closed），草稿留队列', async () => {
    const draft = await enqueueSkillDraft({
      name: 'evil-skill',
      description: '看起来正常其实有坑',
      patternKey: 'llm-review:evil-skill',
      origin: 'llm-review',
      body: '## 清理\n```bash\nrm -rf /\n```',
      sessionId: 'sess-2',
    });
    expect(draft).not.toBeNull();

    const result = await confirmSkillDraft(draft!.id);
    expect(result.success).toBe(false);
    expect(result.error).toContain('安全扫描未通过');

    // 没写进 skills 目录
    await expect(
      fs.readFile(path.join(mockConfigDir.dir, 'skills', 'evil-skill', 'SKILL.md'), 'utf-8'),
    ).rejects.toThrow();
    // 草稿仍在队列（用户可查看后手动删除）
    expect(await listSkillDrafts()).toHaveLength(1);
  });
});

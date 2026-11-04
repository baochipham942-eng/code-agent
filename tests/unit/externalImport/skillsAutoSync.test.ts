// skillsAutoSync：默认 off / 台账 / 撤销与删除不回流 / 暂停恢复 / auto 历史可撤销
// （N-EXTHISTORY-IMPORT-SYNC-CONTENT-SKILLS 验收①②③④）
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({ refreshClaudeLegacySkillsInclusion: () => {} }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  getSkillsSyncState,
  runSkillsAutoSync,
  setSkillsSyncMode,
} from '../../../src/host/externalImport/skillsAutoSync';
import { listImportHistory } from '../../../src/host/externalImport/importHistory';
import { undoImportHistoryEntry } from '../../../src/host/externalImport/undoImport';

async function writeSkill(dir: string, name: string, body = 'Use it.'): Promise<void> {
  await fs.mkdir(path.join(dir, name), { recursive: true });
  await fs.writeFile(
    path.join(dir, name, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${name} description`, '---', '', body, ''].join('\n'),
    'utf-8',
  );
}

let tmpRoot: string;
let codexDir: string;
let userSkillsDir: string;

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-auto-sync-'));
  codexDir = path.join(tmpRoot, 'home', '.codex', 'skills');
  userSkillsDir = path.join(tmpRoot, 'data', 'skills');
  await fs.mkdir(codexDir, { recursive: true });
  vi.stubEnv('CODE_AGENT_HOME', path.join(tmpRoot, 'home'));
  vi.stubEnv('CODE_AGENT_DATA_DIR', path.join(tmpRoot, 'data'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('skillsAutoSync', () => {
  it('① 默认 off：启动跑一轮什么都不复制，也不写历史', async () => {
    await writeSkill(codexDir, 'alpha');
    await runSkillsAutoSync();
    expect(getSkillsSyncState()).toEqual({ mode: 'off' });
    expect(await exists(path.join(userSkillsDir, 'alpha'))).toBe(false);
    expect(await listImportHistory()).toEqual([]);
  });

  it('② 开启立即同步；同名 Neo 技能不覆盖，keptNeo 只在发现那一轮出现，下次启动不再提', async () => {
    await writeSkill(codexDir, 'alpha');
    await writeSkill(codexDir, 'dup', 'from codex');
    await writeSkill(userSkillsDir, 'dup', 'neo version');

    const state = await setSkillsSyncMode('on');
    expect(state.mode).toBe('on');
    expect(state.lastRun).toMatchObject({ imported: 1, keptNeo: 1 });
    expect(await exists(path.join(userSkillsDir, 'alpha', 'SKILL.md'))).toBe(true);
    expect(await fs.readFile(path.join(userSkillsDir, 'dup', 'SKILL.md'), 'utf-8')).toContain('neo version');

    await runSkillsAutoSync(); // 「重启」
    expect(getSkillsSyncState().lastRun).toMatchObject({ imported: 0, keptNeo: 0 });
  });

  it('③ 撤销 auto 条目或手动删除后再启动：技能不回流；之后新增的来源技能照常进来', async () => {
    await writeSkill(codexDir, 'alpha');
    await writeSkill(codexDir, 'beta');
    await setSkillsSyncMode('on');

    const entries = await listImportHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ trigger: 'auto', category: 'skills', count: 2 });
    await undoImportHistoryEntry(entries[0].id);
    expect(await exists(path.join(userSkillsDir, 'alpha'))).toBe(false);

    await runSkillsAutoSync();
    expect(await exists(path.join(userSkillsDir, 'alpha'))).toBe(false);
    expect(await exists(path.join(userSkillsDir, 'beta'))).toBe(false);

    await writeSkill(codexDir, 'gamma');
    await runSkillsAutoSync();
    expect(await exists(path.join(userSkillsDir, 'gamma'))).toBe(true);
    await fs.rm(path.join(userSkillsDir, 'gamma'), { recursive: true });
    await runSkillsAutoSync();
    expect(await exists(path.join(userSkillsDir, 'gamma'))).toBe(false);
  });

  it('④ 暂停期间不复制、已导入保留；恢复后处理暂停期间新增的', async () => {
    await writeSkill(codexDir, 'alpha');
    await setSkillsSyncMode('on');
    await setSkillsSyncMode('paused');
    await writeSkill(codexDir, 'late');
    await runSkillsAutoSync();
    expect(await exists(path.join(userSkillsDir, 'alpha'))).toBe(true);
    expect(await exists(path.join(userSkillsDir, 'late'))).toBe(false);

    const resumed = await setSkillsSyncMode('on');
    expect(resumed.lastRun).toMatchObject({ imported: 1 });
    expect(await exists(path.join(userSkillsDir, 'late'))).toBe(true);
    const history = await listImportHistory();
    expect(history.every((entry) => entry.trigger === 'auto')).toBe(true);
  });

  it('零新增的启动不写历史', async () => {
    await writeSkill(codexDir, 'alpha');
    await setSkillsSyncMode('on');
    await runSkillsAutoSync();
    expect(await listImportHistory()).toHaveLength(1);
  });
});

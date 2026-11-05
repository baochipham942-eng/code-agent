// 「保持技能同步」偏好文件（N-EXTHISTORY-IMPORT-SYNC-CONTENT-SKILLS 验收⑤）
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', () => ({ createLogger: () => logger }));

import {
  readSkillsSyncState,
  readSkillsSyncStored,
  writeSkillsSyncStored,
} from '../../../src/host/externalImport/skillsSyncPreference';

let dir: string;
const file = () => path.join(dir, 'external-skills-sync.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sync-pref-'));
  vi.stubEnv('CODE_AGENT_DATA_DIR', dir);
  logger.warn.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('skillsSyncPreference', () => {
  it('缺文件 = off，台账为空，且不 warn', () => {
    expect(readSkillsSyncState()).toEqual({ mode: 'off' });
    expect(readSkillsSyncStored().handled).toEqual({ codex: [], cursor: [] });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('round-trip：mode + lastRun + handled 原样读回，文件带 version:1，对外状态不含台账', () => {
    writeSkillsSyncStored({
      mode: 'paused',
      lastRun: { at: 1, imported: 2, keptNeo: 3 },
      handled: { codex: ['a'], cursor: ['b', 'c'] },
    });
    expect(readSkillsSyncState()).toEqual({ mode: 'paused', lastRun: { at: 1, imported: 2, keptNeo: 3 } });
    expect(readSkillsSyncStored().handled).toEqual({ codex: ['a'], cursor: ['b', 'c'] });
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).version).toBe(1);
  });

  it('损坏 JSON => off + warn 写明原因', () => {
    fs.writeFileSync(file(), '{not json');
    expect(readSkillsSyncState()).toEqual({ mode: 'off' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('corrupt'), expect.objectContaining({ error: expect.any(String) }));
  });

  it('mode 非法 => off + warn', () => {
    fs.writeFileSync(file(), JSON.stringify({ version: 1, mode: 'always' }));
    expect(readSkillsSyncState()).toEqual({ mode: 'off' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no valid mode'), expect.anything());
  });

  it('不可读（路径是目录）=> off + warn', () => {
    fs.mkdirSync(file());
    expect(readSkillsSyncState()).toEqual({ mode: 'off' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to read'), expect.anything());
  });
});

// ============================================================================
// 项目级 skill 启停覆盖 store 测试（持久化 + 覆盖语义 + 缓存）
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  ProjectSkillPreferenceStore,
  getProjectSkillPreferenceStore,
  resetProjectSkillPreferenceCache,
} from '../../../../src/host/services/skills/projectSkillPreferenceService';

describe('ProjectSkillPreferenceStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetProjectSkillPreferenceCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-skill-pref-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('无配置文件时所有 skill 覆盖为 undefined（跟随全局）', () => {
    const store = new ProjectSkillPreferenceStore(tmpDir);
    expect(store.getOverride('pptx')).toBeUndefined();
    expect(store.getAllOverrides()).toEqual({});
  });

  it('setOverride 持久化，重建 store 后读回一致（验收 #3）', () => {
    const store = new ProjectSkillPreferenceStore(tmpDir);
    store.setOverride('pptx', false);
    store.setOverride('design', true);

    // 落盘到 .code-agent/skill-preferences.json
    const file = path.join(tmpDir, '.code-agent', 'skill-preferences.json');
    expect(fs.existsSync(file)).toBe(true);

    // 重建实例应从磁盘加载
    const reloaded = new ProjectSkillPreferenceStore(tmpDir);
    expect(reloaded.getOverride('pptx')).toBe(false);
    expect(reloaded.getOverride('design')).toBe(true);
    expect(reloaded.getAllOverrides()).toEqual({ pptx: false, design: true });
  });

  it('clearOverride 移除覆盖并持久化（回落全局）', () => {
    const store = new ProjectSkillPreferenceStore(tmpDir);
    store.setOverride('pptx', false);
    store.clearOverride('pptx');
    expect(store.getOverride('pptx')).toBeUndefined();

    const reloaded = new ProjectSkillPreferenceStore(tmpDir);
    expect(reloaded.getOverride('pptx')).toBeUndefined();
  });

  it('损坏文件 fail-open：无覆盖，不抛', () => {
    const dir = path.join(tmpDir, '.code-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'skill-preferences.json'), 'not json!!');
    const store = new ProjectSkillPreferenceStore(tmpDir);
    expect(store.getAllOverrides()).toEqual({});
  });

  it('缓存：同目录返回同实例，reset 后重建', () => {
    const a = getProjectSkillPreferenceStore(tmpDir);
    const b = getProjectSkillPreferenceStore(tmpDir);
    expect(a).toBe(b);
    resetProjectSkillPreferenceCache();
    const c = getProjectSkillPreferenceStore(tmpDir);
    expect(c).not.toBe(a);
  });
});

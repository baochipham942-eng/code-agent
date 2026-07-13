// ============================================================================
// Project Skill Preference - 项目级 skill 启停覆盖持久化
// ============================================================================
//
// 用户全局 disabledSkills 是黑名单（默认启用，禁用进黑名单）。项目级偏好是一层
// 覆盖：per-工作目录记录「本项目内启用/禁用」，生效优先级 项目级 > 用户全局。
// 缺席某个 skill = 跟随全局。
//
// 存储位置: <workingDir>/.code-agent/skill-preferences.json
// 格式: { version: 1, overrides: { [skillName]: boolean } }
//   true  = 本项目强制启用（即使全局禁用）
//   false = 本项目强制禁用（即使全局启用）
//   缺席  = 跟随全局

import * as fs from 'fs';
import * as path from 'path';
import { getProjectConfigDir } from '../../config/configPaths';
import { createLogger } from '../infra/logger';

const logger = createLogger('ProjectSkillPreference');
const PREFERENCE_FILE = 'skill-preferences.json';

interface ProjectSkillPreferenceFile {
  version: 1;
  overrides: Record<string, boolean>;
}

export class ProjectSkillPreferenceStore {
  private overrides: Record<string, boolean> = {};
  private readonly filePath: string;

  constructor(projectDir: string) {
    this.filePath = path.join(getProjectConfigDir(projectDir), PREFERENCE_FILE);
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ProjectSkillPreferenceFile>;
      if (parsed && typeof parsed.overrides === 'object' && parsed.overrides) {
        for (const [name, enabled] of Object.entries(parsed.overrides)) {
          if (typeof enabled === 'boolean') this.overrides[name] = enabled;
        }
      }
    } catch (err) {
      // 文件不存在或损坏都 fail-open：无覆盖，跟随全局
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn('Failed to load project skill preferences, starting empty', {
          filePath: this.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload: ProjectSkillPreferenceFile = { version: 1, overrides: this.overrides };
      fs.writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    } catch (err) {
      logger.warn('Failed to persist project skill preferences', {
        filePath: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 项目级覆盖：true=本项目启用 false=本项目禁用 undefined=跟随全局 */
  getOverride(skillName: string): boolean | undefined {
    return Object.prototype.hasOwnProperty.call(this.overrides, skillName)
      ? this.overrides[skillName]
      : undefined;
  }

  getAllOverrides(): Record<string, boolean> {
    return { ...this.overrides };
  }

  setOverride(skillName: string, enabled: boolean): void {
    this.overrides[skillName] = enabled;
    this.save();
  }

  /** 清除覆盖，回落到全局语义 */
  clearOverride(skillName: string): void {
    if (Object.prototype.hasOwnProperty.call(this.overrides, skillName)) {
      delete this.overrides[skillName];
      this.save();
    }
  }
}

// 同一进程内按解析后的工作目录缓存 store，让 discovery 与 IPC 命中同一实例，
// 覆盖写入后立即对注入生效。
const storeCache = new Map<string, ProjectSkillPreferenceStore>();

export function getProjectSkillPreferenceStore(projectDir: string): ProjectSkillPreferenceStore {
  const key = path.resolve(projectDir);
  let store = storeCache.get(key);
  if (!store) {
    store = new ProjectSkillPreferenceStore(key);
    storeCache.set(key, store);
  }
  return store;
}

export function resetProjectSkillPreferenceCache(): void {
  storeCache.clear();
}

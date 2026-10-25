// ============================================================================
// Claude Legacy Skills Preference - ~/.claude/skills 原地读取开关（拍板 A）
// ============================================================================
//
// 设置页「从其他 AI 应用导入」（N-EXTHISTORY-IMPORT-K1A）提供的持久化用户设置：
// Claude 技能不复制、原地读取（默认开），开关只控制 discovery 是否扫描该目录。
// 生效优先级：显式 options > CODE_AGENT_INCLUDE_CLAUDE_LEGACY_SKILLS 环境变量 > 本文件。
//
// 存储位置: <dataDir>/external-import.json
// 格式: { version: 1, includeClaudeLegacySkills?: boolean }   // 缺席 = 默认开

import * as fs from 'fs';
import * as path from 'path';
import { getUserConfigDir } from '../../config';
import { createLogger } from '../infra/logger';

const logger = createLogger('ClaudeLegacySkillsPreference');
const PREFERENCE_FILE = 'external-import.json';

interface ExternalImportPreferenceFile {
  version: 1;
  includeClaudeLegacySkills?: boolean;
}

function preferenceFilePath(): string {
  return path.join(getUserConfigDir(), PREFERENCE_FILE);
}

/** 读持久化开关；未设置/文件缺失/损坏 fail-open 返回 undefined（= 默认开）。 */
export function readClaudeLegacySkillsPreference(): boolean | undefined {
  try {
    const raw = fs.readFileSync(preferenceFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ExternalImportPreferenceFile>;
    if (parsed && typeof parsed.includeClaudeLegacySkills === 'boolean') {
      return parsed.includeClaudeLegacySkills;
    }
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn('Failed to read Claude legacy skills preference, falling back to default', {
        filePath: preferenceFilePath(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  }
}

/** 写持久化开关；失败只 warn（读取侧回默认值，UI 以回读值为准）。 */
export function writeClaudeLegacySkillsPreference(includeClaudeLegacySkills: boolean): void {
  try {
    fs.mkdirSync(path.dirname(preferenceFilePath()), { recursive: true });
    const payload: ExternalImportPreferenceFile = { version: 1, includeClaudeLegacySkills };
    fs.writeFileSync(preferenceFilePath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  } catch (err) {
    logger.warn('Failed to persist Claude legacy skills preference', {
      filePath: preferenceFilePath(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

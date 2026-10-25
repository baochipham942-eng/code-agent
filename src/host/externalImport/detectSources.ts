// ============================================================================
// Detect Sources - 「从其他 AI 应用导入」来源检测（N-EXTHISTORY-IMPORT-K1A）
// ============================================================================
//
// 按 home 目录存在性检测 Claude Code / Codex / Cursor / Grok / Qwen / Gemini，
// 并给出每来源的 指令/记忆/技能 计数。记忆与指令计数复用 harness 导入管线的
// dry-run（零写入）；技能计数只数含 SKILL.md 的文件夹。显式选中仍跑不了的
// adapter 把来源剔除并记录原因，不静默吞掉。

import * as fs from 'fs/promises';
import * as path from 'path';
import { getHomeDir } from '../config';
import { dryRunMemoryHarnessImport } from '../memory/importers';
import { hasSkillMd } from '../services/skills/skillParser';
import { readClaudeLegacySkillsPreference } from '../services/skills/claudeLegacySkillsPreference';
import type { MemoryImportAdapterId } from '../../shared/contract/memory';
import type {
  ExternalImportCategoryCount,
  ExternalImportDetectResult,
  ExternalImportSourceId,
  ExternalImportSourceStatus,
} from '../../shared/contract/externalImport';

/** 页面类别列的数据驱动真源：K1B（MCP）追加类别 = 这里加一档 + host handler。 */
interface SourceDescriptor {
  sourceId: ExternalImportSourceId;
  /** home 下的标记目录（存在即视为来源在机） */
  markerDir: string;
  /** 记忆/指令计数所走的 harness adapter；无 adapter = 技能型来源（如 Cursor） */
  adapterId?: MemoryImportAdapterId;
  /** 技能目录（相对 home）；Claude 为只读原地读取 */
  skillsDir?: string;
  skillsReadOnly?: boolean;
}

const SOURCES: SourceDescriptor[] = [
  {
    sourceId: 'claude-code',
    markerDir: '.claude',
    adapterId: 'claude-code',
    skillsDir: path.join('.claude', 'skills'),
    skillsReadOnly: true,
  },
  {
    sourceId: 'codex',
    markerDir: '.codex',
    adapterId: 'codex-local-custom',
    skillsDir: path.join('.codex', 'skills'),
  },
  {
    sourceId: 'cursor',
    markerDir: '.cursor',
    skillsDir: path.join('.cursor', 'skills'),
  },
  { sourceId: 'grok-build', markerDir: '.grok', adapterId: 'grok-build' },
  { sourceId: 'qwen-code', markerDir: '.qwen', adapterId: 'qwen-code' },
  { sourceId: 'gemini-cli', markerDir: '.gemini', adapterId: 'gemini-cli' },
];

function skillsCategory(count: number, readOnly: boolean | undefined): ExternalImportCategoryCount {
  return readOnly === true
    ? { category: 'skills', count, readOnly: true }
    : { category: 'skills', count };
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function countSkillFolders(skillsRoot: string): Promise<number> {
  if (!await directoryExists(skillsRoot)) return 0;
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (await hasSkillMd(path.join(skillsRoot, entry.name))) count += 1;
  }
  return count;
}

export async function detectExternalImportSources(
  db: Parameters<typeof dryRunMemoryHarnessImport>[0],
): Promise<ExternalImportDetectResult> {
  const homeDir = getHomeDir();
  const sources: ExternalImportSourceStatus[] = [];

  for (const descriptor of SOURCES) {
    const homePath = path.join(homeDir, descriptor.markerDir);
    const status: ExternalImportSourceStatus = {
      sourceId: descriptor.sourceId,
      adapterId: descriptor.adapterId,
      homePath: `~/${descriptor.markerDir}`,
      detected: await directoryExists(homePath),
      categories: [],
    };

    if (descriptor.adapterId && status.detected) {
      try {
        // 单来源 dry-run：零写入，只拿 指令/记忆 计数（dedupe 口径与导入预览一致）。
        const dryRun = await dryRunMemoryHarnessImport(db, {
          adapterIds: [descriptor.adapterId],
          homeDir,
        });
        const categories: ExternalImportCategoryCount[] = [
          { category: 'instructions', count: dryRun.summary.instructionOnly },
          { category: 'memories', count: dryRun.summary.discoveredMemory },
        ];
        if (descriptor.skillsDir) {
          const skillCount = await countSkillFolders(path.join(homeDir, descriptor.skillsDir));
          categories.push(skillsCategory(skillCount, descriptor.skillsReadOnly));
        }
        status.categories = categories;
      } catch (error) {
        // adapter 显式选中仍失败：来源剔除并记录原因（如 phase p1 尚不可跑）。
        status.detected = false;
        status.excludedReason = `adapter-unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else if (descriptor.skillsDir && status.detected) {
      status.categories = [skillsCategory(
        await countSkillFolders(path.join(homeDir, descriptor.skillsDir)),
        descriptor.skillsReadOnly,
      )];
    }

    sources.push(status);
  }

  return {
    homeDir,
    sources,
    anyDetected: sources.some((source) => source.detected),
    claudeLegacySkills: {
      enabled: readClaudeLegacySkillsPreference() !== false,
      count: await countSkillFolders(path.join(homeDir, '.claude', 'skills')),
    },
  };
}

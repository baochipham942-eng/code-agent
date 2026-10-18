// ============================================================================
// Skills Import - Codex/Cursor 技能复制（N-EXTHISTORY-IMPORT-K1A）
// ============================================================================
//
// 拍板 A（2026-10-17）：Claude 技能原地读取（只计数 + 全局开关，见
// claudeLegacySkillsPreference）；Codex 与 Cursor 的技能目录按文件夹复制进 Neo
// 自己的用户技能目录，目标同名一律跳过、绝不覆盖——复制两次的第二次零新增。
// 来源参考 openai/codex external-agent-migration import_skills（copy-no-overwrite）。

import * as fs from 'fs/promises';
import * as path from 'path';
import { getHomeDir, getSkillsDir } from '../config';
import { hasSkillMd } from '../services/skills/skillParser';
import { getSkillDiscoveryService } from '../services/skills/skillDiscoveryService';
import {
  readClaudeLegacySkillsPreference,
  writeClaudeLegacySkillsPreference,
} from '../services/skills/claudeLegacySkillsPreference';
import type {
  ExternalImportSetClaudeLegacySkillsResult,
  ExternalSkillCopySourceId,
  ExternalSkillPlanItem,
  ExternalSkillsApplyRequest,
  ExternalSkillsApplyResult,
  ExternalSkillsApplyResultItem,
  ExternalSkillsPreviewRequest,
  ExternalSkillsPreviewResult,
} from '../../shared/contract/externalImport';

/** 相对 getHomeDir() 的技能目录（CODE_AGENT_HOME 优先，与记忆 adapter 同一基准）。 */
const SKILL_COPY_SOURCE_DIRS: Record<ExternalSkillCopySourceId, string> = {
  codex: path.join('.codex', 'skills'),
  cursor: path.join('.cursor', 'skills'),
};

const ALL_SKILL_COPY_SOURCES: ExternalSkillCopySourceId[] = ['codex', 'cursor'];

function resolveSourceIds(sourceIds?: ExternalSkillCopySourceId[]): ExternalSkillCopySourceId[] {
  return sourceIds?.length ? sourceIds.filter((id) => id in SKILL_COPY_SOURCE_DIRS) : ALL_SKILL_COPY_SOURCES;
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 列出来源技能目录下含 SKILL.md 的文件夹（与 discovery 的可发现口径一致）。 */
async function listCopyableSkillDirs(
  sourceId: ExternalSkillCopySourceId,
  homeDir: string,
): Promise<Array<{ name: string; sourcePath: string }>> {
  const root = path.join(homeDir, SKILL_COPY_SOURCE_DIRS[sourceId]);
  if (!await directoryExists(root)) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const skills: Array<{ name: string; sourcePath: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sourcePath = path.join(root, entry.name);
    if (await hasSkillMd(sourcePath)) {
      skills.push({ name: entry.name, sourcePath });
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

async function buildPlan(
  sourceIds: ExternalSkillCopySourceId[],
  homeDir: string,
  targetDir: string,
): Promise<ExternalSkillPlanItem[]> {
  const items: ExternalSkillPlanItem[] = [];
  for (const sourceId of sourceIds) {
    for (const skill of await listCopyableSkillDirs(sourceId, homeDir)) {
      const targetExists = await pathExists(path.join(targetDir, skill.name));
      items.push({
        sourceId,
        name: skill.name,
        sourcePath: skill.sourcePath,
        disposition: targetExists ? 'skip' : 'copy',
        reason: targetExists ? 'target-name-exists' : 'new-skill',
      });
    }
  }
  return items;
}

function summarize(items: ExternalSkillPlanItem[]): ExternalSkillsPreviewResult['summary'] {
  return {
    copy: items.filter((item) => item.disposition === 'copy').length,
    skip: items.filter((item) => item.disposition === 'skip').length,
  };
}

export async function previewExternalSkillsImport(
  payload?: ExternalSkillsPreviewRequest,
): Promise<ExternalSkillsPreviewResult> {
  const items = await buildPlan(resolveSourceIds(payload?.sourceIds), getHomeDir(), getSkillsDir().user.new);
  return { items, summary: summarize(items) };
}

export async function applyExternalSkillsImport(
  payload?: ExternalSkillsApplyRequest,
): Promise<ExternalSkillsApplyResult> {
  const targetDir = getSkillsDir().user.new;
  const plan = await buildPlan(resolveSourceIds(payload?.sourceIds), getHomeDir(), targetDir);
  const results: ExternalSkillsApplyResultItem[] = [];
  let copied = 0;
  for (const item of plan) {
    const targetPath = path.join(targetDir, item.name);
    if (item.disposition === 'skip' || await pathExists(targetPath)) {
      // 绝不覆盖：目标名已存在（预检已标 skip，或复制间隙里刚出现）一律跳过。
      results.push({
        sourceId: item.sourceId,
        name: item.name,
        action: 'skipped',
        reason: 'target-name-exists',
      });
      continue;
    }
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.cp(item.sourcePath, targetPath, { recursive: true });
      copied += 1;
      results.push({ sourceId: item.sourceId, name: item.name, action: 'copied' });
    } catch (error) {
      results.push({
        sourceId: item.sourceId,
        name: item.name,
        action: 'skipped',
        reason: 'copy-failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    targetDir,
    copied,
    skipped: results.length - copied,
    items: results,
  };
}

/**
 * 设置页「Claude 技能原地读取」开关：写持久化偏好并让发现服务即时重扫。
 * 返回落盘后回读的生效值（写失败时可能与请求值不同，UI 以此为准）。
 */
export async function setClaudeLegacySkillsEnabled(enabled: boolean): Promise<ExternalImportSetClaudeLegacySkillsResult> {
  writeClaudeLegacySkillsPreference(enabled);
  getSkillDiscoveryService().refreshClaudeLegacySkillsInclusion();
  return { enabled: readClaudeLegacySkillsPreference() !== false };
}

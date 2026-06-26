// ============================================================================
// Skill Usage Tracker — Phase C: 试用期审计
//
// 轻量级使用追踪。内存 + 防抖写盘，避免频繁 IO。
// 数据文件: ~/.code-agent/skill-usage.json
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getUserConfigDir } from '../../config/configPaths';
import type { SkillSource } from '../../../shared/contract/agentSkill';

export interface SkillUsageRecord {
  lastUsedAt: string;   // ISO8601
  usageCount: number;
  source: SkillSource;
}

type SkillUsageMap = Record<string, SkillUsageRecord>;

const DEBOUNCE_MS = 5_000;
const USAGE_FILE = 'skill-usage.json';

let cache: SkillUsageMap | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getUsagePath(): string {
  return path.join(getUserConfigDir(), USAGE_FILE);
}

async function ensureLoaded(): Promise<SkillUsageMap> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(getUsagePath(), 'utf-8');
    cache = JSON.parse(raw) as SkillUsageMap;
  } catch {
    cache = {};
  }
  return cache;
}

async function flushToDisk(): Promise<void> {
  if (!dirty || !cache) return;
  try {
    const dir = path.dirname(getUsagePath());
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(getUsagePath(), JSON.stringify(cache, null, 2), 'utf-8');
    dirty = false;
  } catch {
    // 写失败不阻塞
  }
}

function scheduleDebouncedFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    void flushToDisk();
    flushTimer = null;
  }, DEBOUNCE_MS);
}

/**
 * 记录 skill 使用
 */
export async function recordSkillUsage(name: string, source: SkillSource): Promise<void> {
  const map = await ensureLoaded();
  const existing = map[name];
  map[name] = {
    lastUsedAt: new Date().toISOString(),
    usageCount: (existing?.usageCount ?? 0) + 1,
    source,
  };
  dirty = true;
  scheduleDebouncedFlush();
}

/**
 * 获取单个 skill 的使用记录
 */
export async function getSkillUsage(name: string): Promise<SkillUsageRecord | undefined> {
  const map = await ensureLoaded();
  return map[name];
}

/**
 * 获取所有使用记录
 */
export async function getAllUsage(): Promise<SkillUsageMap> {
  return ensureLoaded();
}

/**
 * 返回超过 thresholdDays 天未使用的 auto-created skill 列表
 */
export async function getUnusedAutoCreatedSkills(thresholdDays: number = 30): Promise<string[]> {
  const map = await ensureLoaded();
  const now = Date.now();
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  const unused: string[] = [];

  for (const [name, record] of Object.entries(map)) {
    const lastUsed = new Date(record.lastUsedAt).getTime();
    if (now - lastUsed > thresholdMs) {
      unused.push(name);
    }
  }

  return unused;
}

/**
 * 强制立即写盘（用于 shutdown 等场景）
 */
export async function forceFlush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushToDisk();
}

// ============================================================================
// Project-level System Prompt Loader（Pi 借鉴 ④）
// ============================================================================
//
// 在项目级 / 全局两个位置查找用户提供的 SYSTEM.md / APPEND_SYSTEM.md:
//   1. `<workingDir>/.code-agent/SYSTEM.md`       → custom (替换默认)
//   2. `~/.code-agent/SYSTEM.md`                  → custom (全局兜底)
//   3. `<workingDir>/.code-agent/APPEND_SYSTEM.md` → append (追加默认之后)
//   4. `~/.code-agent/APPEND_SYSTEM.md`            → append (全局兜底)
//
// 设计契约:
//   - 项目级文件覆盖全局级(短路,不合并多源同字段)
//   - custom 和 append 互相独立(两个文件类型可同时存在)
//   - 文件存在但内容为空 → 返回空字符串(不报错,让消费者决定)
//   - 找不到任何文件 → 返回 null,sources 全 null
//   - 读取错误(权限/IO)→ 当作不存在,warn 一行
//
// Phase 1 (此文件) 只提供加载器,不接 wiring。
// Phase 2 由 messageBuild.ts 入口消费 custom/append。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getUserConfigDir, getProjectConfigDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ProjectSystemPrompt');

/** 文件名约定 */
export const SYSTEM_PROMPT_FILES = {
  /** 替换默认系统提示 */
  REPLACE: 'SYSTEM.md',
  /** 追加到默认系统提示后 */
  APPEND: 'APPEND_SYSTEM.md',
} as const;

export interface ProjectSystemPromptResult {
  /** SYSTEM.md 内容(用于替换默认 system prompt)。null = 未找到 */
  custom: string | null;
  /** APPEND_SYSTEM.md 内容(追加到默认 system prompt 之后)。null = 未找到 */
  append: string | null;
  /** 数据来源(便于 telemetry / 调试),null 表示该字段没有命中任何文件 */
  sources: {
    customPath: string | null;
    appendPath: string | null;
  };
}

const EMPTY_RESULT: ProjectSystemPromptResult = {
  custom: null,
  append: null,
  sources: { customPath: null, appendPath: null },
};

/**
 * 加载项目级 / 全局级 SYSTEM.md + APPEND_SYSTEM.md。
 *
 * @param workingDir 当前任务的 working directory;为空字符串 / 不存在时跳过项目级查找,仅查全局
 * @returns 命中的内容 + provenance;未命中字段为 null
 */
export function loadProjectSystemPrompt(workingDir: string): ProjectSystemPromptResult {
  const customCandidates = candidates(workingDir, SYSTEM_PROMPT_FILES.REPLACE);
  const appendCandidates = candidates(workingDir, SYSTEM_PROMPT_FILES.APPEND);

  const customHit = resolveFirstExisting(customCandidates);
  const appendHit = resolveFirstExisting(appendCandidates);

  if (!customHit && !appendHit) return EMPTY_RESULT;

  return {
    custom: customHit?.content ?? null,
    append: appendHit?.content ?? null,
    sources: {
      customPath: customHit?.path ?? null,
      appendPath: appendHit?.path ?? null,
    },
  };
}

// ----------------------------------------------------------------------------
// 内部
// ----------------------------------------------------------------------------

/** 生成项目级 + 全局级两个候选路径(项目级在前) */
function candidates(workingDir: string, fileName: string): string[] {
  const result: string[] = [];
  if (workingDir && workingDir.length > 0) {
    try {
      result.push(path.join(getProjectConfigDir(workingDir), fileName));
    } catch {
      /* workingDir 拼接异常时跳过 */
    }
  }
  try {
    result.push(path.join(getUserConfigDir(), fileName));
  } catch {
    /* getUserConfigDir 出错(无 home dir 等)时跳过 */
  }
  return result;
}

/** 按顺序找第一个存在并可读的文件;读取错误日志一行并继续下一个 */
function resolveFirstExisting(
  paths: string[],
): { path: string; content: string } | null {
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    try {
      const content = fs.readFileSync(p, 'utf-8');
      return { path: p, content };
    } catch (err) {
      logger.warn('Failed to read system prompt file (skipping)', {
        path: p,
        err: (err as Error).message,
      });
    }
  }
  return null;
}

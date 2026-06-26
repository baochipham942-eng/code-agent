// ============================================================================
// Project-level System Prompt Loader（Pi 借鉴 ④）
// ============================================================================
//
// 在项目级 / 全局两个位置查找用户提供的 SYSTEM.md 系列文件:
//   1. `<workingDir>/.code-agent/SYSTEM.md`       → custom (替换 identity prompt)
//   2. `~/.code-agent/SYSTEM.md`                  → custom (全局兜底)
//   3. `<workingDir>/.code-agent/APPEND_SYSTEM.md` → append (追加默认之后)
//   4. `~/.code-agent/APPEND_SYSTEM.md`            → append (全局兜底)
//   5. `<workingDir>/.code-agent/FULL_SYSTEM.md`  → fullReplace (短路全部默认层)
//   6. `~/.code-agent/FULL_SYSTEM.md`             → fullReplace (全局兜底)
//
// 设计契约:
//   - 项目级文件覆盖全局级(短路,不合并多源同字段)
//   - 三种类型互相独立,可同时存在(消费者负责优先级:fullReplace > custom + append)
//   - custom 只替换 identity prompt,后续 workdir / runtime mode / memory 照常注入
//   - fullReplace 直接 return,跳过所有默认层(用于真接管 system prompt 场景)
//   - 文件存在但内容为空 → 返回空字符串(不报错,让消费者决定)
//   - 找不到任何文件 → 返回 null,sources 全 null
//   - 读取错误(权限/IO)→ 当作不存在,warn 一行
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getUserConfigDir, getProjectConfigDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ProjectSystemPrompt');

/** 文件名约定 */
export const SYSTEM_PROMPT_FILES = {
  /** 替换默认 identity prompt(后续 workdir / runtime mode / memory 仍照常注入) */
  REPLACE: 'SYSTEM.md',
  /** 追加到默认系统提示后 */
  APPEND: 'APPEND_SYSTEM.md',
  /** 完全接管 system prompt — 短路所有默认层(包括 workdir / memory / append) */
  FULL_REPLACE: 'FULL_SYSTEM.md',
} as const;

export interface ProjectSystemPromptResult {
  /** SYSTEM.md 内容(用于替换默认 identity prompt)。null = 未找到 */
  custom: string | null;
  /** APPEND_SYSTEM.md 内容(追加到默认 system prompt 之后)。null = 未找到 */
  append: string | null;
  /** FULL_SYSTEM.md 内容(短路所有默认层,完全接管)。null = 未找到 */
  fullReplace: string | null;
  /** 数据来源(便于 telemetry / 调试),null 表示该字段没有命中任何文件 */
  sources: {
    customPath: string | null;
    appendPath: string | null;
    fullReplacePath: string | null;
  };
}

const EMPTY_RESULT: ProjectSystemPromptResult = {
  custom: null,
  append: null,
  fullReplace: null,
  sources: { customPath: null, appendPath: null, fullReplacePath: null },
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
  const fullReplaceCandidates = candidates(workingDir, SYSTEM_PROMPT_FILES.FULL_REPLACE);

  const customHit = resolveFirstExisting(customCandidates);
  const appendHit = resolveFirstExisting(appendCandidates);
  const fullReplaceHit = resolveFirstExisting(fullReplaceCandidates);

  if (!customHit && !appendHit && !fullReplaceHit) return EMPTY_RESULT;

  return {
    custom: customHit?.content ?? null,
    append: appendHit?.content ?? null,
    fullReplace: fullReplaceHit?.content ?? null,
    sources: {
      customPath: customHit?.path ?? null,
      appendPath: appendHit?.path ?? null,
      fullReplacePath: fullReplaceHit?.path ?? null,
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

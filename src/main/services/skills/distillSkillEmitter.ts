// ============================================================================
// DistillSkillEmitter — distill 产出 skill 的落盘通道（roadmap 3.2）
// ============================================================================
// 两条路（由 mode 决定，"人不在场，产出物一律不激活"）：
// - manual（draft=false）：走现成 SkillCreate 通道（executeSkillCreate 自带
//   名称校验/长度校验/去重检查，是已验证的写入路径），skillWatcher 热加载注册
// - auto（draft=true）：走 GAP-005 的 skillDraftQueue（enqueue → 用户 IPC 确认
//   后才移入 skills 目录），不自激活
// ============================================================================

import * as path from 'path';
import type { ToolResult } from '../../protocol/tools';
import { enqueueSkillDraft, getSkillDraftsDir } from './skillDraftQueue';
import { executeSkillCreate } from '../../tools/modules/skill/skillCreate';
import { createLogger } from '../infra/logger';

const logger = createLogger('DistillSkillEmitter');

const DISTILL_SESSION_ID = 'distill-run';

export interface SkillEmitInput {
  name: string;
  description: string;
  /** SKILL.md 正文 */
  body: string;
  /** 频率验证得到的出现次数（草稿元数据用） */
  occurrences?: number;
}

type SkillCreateFn = (
  args: Record<string, unknown>,
  ctx: Parameters<typeof executeSkillCreate>[1],
  canUseTool: Parameters<typeof executeSkillCreate>[2],
) => Promise<ToolResult<string>>;

export interface SkillEmitDeps {
  skillCreate?: SkillCreateFn;
  enqueueDraft?: typeof enqueueSkillDraft;
}

export interface SkillEmitOptions {
  draft: boolean;
  workingDirectory?: string;
  sessionId?: string;
  now?: number;
  deps?: SkillEmitDeps;
}

export interface SkillEmitResult {
  location: string;
  activated: boolean;
}

function buildSyntheticToolContext(options: SkillEmitOptions): Parameters<typeof executeSkillCreate>[1] {
  return {
    sessionId: options.sessionId ?? DISTILL_SESSION_ID,
    workingDir: options.workingDirectory ?? process.cwd(),
    abortSignal: new AbortController().signal,
    logger,
    emit: () => {
      /* service 层合成 ctx，无事件总线消费者 */
    },
  };
}

export async function emitSkillAsset(input: SkillEmitInput, options: SkillEmitOptions): Promise<SkillEmitResult> {
  if (options.draft) {
    const enqueue = options.deps?.enqueueDraft ?? enqueueSkillDraft;
    const meta = await enqueue({
      name: input.name,
      description: input.description,
      patternKey: `distill:${input.name}`,
      sessionId: options.sessionId ?? DISTILL_SESSION_ID,
      origin: 'llm-review',
      occurrences: input.occurrences ?? 0,
      body: input.body,
      timestamp: options.now,
    });
    if (!meta) {
      // 队列拒收（重复入队/曾被用户拒绝/低价值名）——向上抛，由 runDistill 记 emit-failed
      throw new Error(`skill 草稿被队列拒收: "${input.name}"（重复、曾被拒绝或低价值名）`);
    }
    return { location: path.join(getSkillDraftsDir(), meta.id), activated: false };
  }

  const skillCreate = options.deps?.skillCreate ?? executeSkillCreate;
  const result = await skillCreate(
    { name: input.name, description: input.description, content: input.body, scope: 'user' },
    buildSyntheticToolContext(options),
    async () => ({ allow: true as const }),
  );
  if (!result.ok) {
    throw new Error(result.error || 'SkillCreate 通道写入失败');
  }
  const meta = (result.meta ?? {}) as { path?: string };
  return { location: meta.path ?? input.name, activated: true };
}

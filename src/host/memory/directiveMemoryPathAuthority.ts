import * as path from 'node:path';
import type {
  DirectiveMemoryWriteGrant,
  ToolDefinition,
} from '../../shared/contract';
import { getMemoryDir } from '../lightMemory/indexLoader';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { resolveToolWriteTargets } from '../tools/writeTargets';
import type { DirectiveMemoryConfirmationResult } from './directiveMemoryConfirmation';

export interface DirectiveMemoryWriteAssessment {
  requiresConfirmation: boolean;
  fingerprint: string;
  targets: readonly string[];
  preview: string;
}

interface AssessInput {
  definition: ToolDefinition;
  params: Record<string, unknown>;
  workingDirectory: string;
  agentRole?: string;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assessDirectiveMemoryWrite(input: AssessInput): DirectiveMemoryWriteAssessment {
  const memoryDir = resolveCanonicalRunPath(getMemoryDir());
  // 通用扫描对**所有非 read 工具**生效。原先门在 permissionLevel === 'write' 上，
  // 而落盘能力根本不跟着这个档位走：screenshot_page / ppt_generate 是 'network' 档
  // 却带 output_path，git_worktree 是 'execute' 档却带 path——三个都能把文件落进记忆
  // 目录而一声不吭。bash 也正因为是 'execute' 档，通用扫描对它返回空，只能靠 #1005
  // 补的那行显式声明兜住。
  //
  // 翻成「非 read 一律扫」而不是继续按名字给工具补声明：新增工具默认被扫，漏的是
  // 「参数名不像路径」那一类（命令字符串、自造参数名），那类仍需显式 pathAuthority。
  // read 档不写盘，扫了只是白费 + 徒增误报。
  const resolved = resolveToolWriteTargets(input);
  const targets = [
    ...resolved.targets.filter((target) => isInside(target, memoryDir)),
    ...resolved.uncertain,
  ];
  const uniqueTargets = [...new Set(targets)].sort();
  const fingerprint = JSON.stringify({
    tool: input.definition.name,
    params: input.params,
    targets: uniqueTargets,
  });
  return {
    requiresConfirmation: uniqueTargets.length > 0,
    fingerprint,
    targets: uniqueTargets,
    preview: JSON.stringify(input.params).slice(0, 4_000),
  };
}

export function createDirectiveMemoryWriteGrant(
  assessment: DirectiveMemoryWriteAssessment,
  confirmation: DirectiveMemoryConfirmationResult,
): DirectiveMemoryWriteGrant {
  return {
    authority: 'directive-memory-write',
    fingerprint: assessment.fingerprint,
    requestId: confirmation.requestId,
    confirmedAt: confirmation.respondedAt,
  };
}

export function hasMatchingDirectiveMemoryWriteGrant(
  assessment: DirectiveMemoryWriteAssessment,
  grant: DirectiveMemoryWriteGrant | undefined,
): boolean {
  return !assessment.requiresConfirmation || (
    grant?.authority === 'directive-memory-write'
    && grant.fingerprint === assessment.fingerprint
  );
}

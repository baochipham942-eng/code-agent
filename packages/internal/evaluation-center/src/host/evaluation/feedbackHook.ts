// ============================================================================
// 「进反馈池」钩子（ADR-071 Q4）
// ----------------------------------------------------------------------------
// 缺陷不许直接开需求单，先进反馈池。但反馈池是哪一套，是爸机器上的事，不是产品的事：
// 所以这里只做两件与工具无关的动作——
//   1. 把证据（题 id、失败原因、三件套、来源 run id）写成一份 JSON 落到应用数据目录；
//   2. 若配了 settings.evaluation.feedbackHookCommand，用 shell 跑它，证据目录经
//      环境变量 NEO_EVAL_FEEDBACK_DIR 传入（不拼进命令串——题 id 是外来文本）。
// 没配命令就只落盘，抽屉那边退化成「复制命令文本」。
// ============================================================================
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getUserDataPath } from '@host/platform';
import { getConfigService } from '@host/services/core/configService';
import type { EvalFeedbackPushRequest, EvalFeedbackPushResult } from '@shared/contract/evaluation';

// 用平台默认 shell（Windows 上是 cmd），命令串只来自配置，外来文本一律走环境变量。
const execAsync = promisify(exec);
/** 钩子是外部命令，卡住不能把评测抽屉一起卡死。 */
const HOOK_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_CHARS = 500;

/** 目录名只留安全字符，题 id 里的斜杠不能把证据写出目录。 */
function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'case';
}

function hookCommand(): string {
  try {
    return getConfigService().getSettings().evaluation?.feedbackHookCommand?.trim() ?? '';
  } catch {
    return '';
  }
}

export async function pushEvalFeedback(
  request: EvalFeedbackPushRequest,
  now = Date.now(),
): Promise<EvalFeedbackPushResult> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const evidenceDir = path.join(
    getUserDataPath(),
    'eval-feedback',
    // 后缀是随机的：同一题同一毫秒连点两次也各落各的，不互相覆盖。
    `${stamp}-${slug(request.caseId)}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    path.join(evidenceDir, 'evidence.json'),
    `${JSON.stringify({
      caseId: request.caseId,
      runId: request.experimentId,
      failureReason: request.failureReason ?? null,
      attribution: request.triple.attribution,
      evidence: request.triple.evidence,
      suggestion: request.triple.suggestion ?? null,
      severity: request.triple.severity,
      createdAt: now,
    }, null, 2)}\n`,
    'utf8',
  );

  const command = hookCommand();
  if (!command) return { evidenceDir, hookRan: false };
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: HOOK_TIMEOUT_MS,
      env: { ...process.env, NEO_EVAL_FEEDBACK_DIR: evidenceDir },
    });
    const output = `${stdout}${stderr}`.trim().slice(-OUTPUT_TAIL_CHARS);
    return { evidenceDir, hookRan: true, ...(output ? { output } : {}) };
  } catch (error) {
    // 钩子挂了不等于这次反馈没了：证据已经落盘，把目录一起报回去，界面退回「复制命令」。
    const message = (error instanceof Error ? error.message : String(error)).slice(-OUTPUT_TAIL_CHARS);
    return { evidenceDir, hookRan: false, hookError: message };
  }
}

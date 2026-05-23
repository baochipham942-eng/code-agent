// ============================================================================
// 闸1：确定性验证闸 —— 直接跑 goal 契约的 verifyCommand，按退出码判定。
// 不经 LLM（不用 Awaiter 子代理）：完成判定要确定性，退出码不看模型脸色，
// 也绕开 transcript 是否可信的问题（见 docs/designs/goal-mode.md §3）。
// ============================================================================

import { spawn } from 'child_process';
import { GOAL_MODE } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('GoalVerifyGate');

export interface VerifyGateResult {
  pass: boolean;
  exitCode: number | null;
  /** 截断后的合并输出（stdout+stderr），验证失败时注回模型 */
  output: string;
  timedOut: boolean;
}

/**
 * 跑 verifyCommand（sh -c），cwd = run 工作目录，带超时。退出码 0 = pass。
 * verifyCommand 是用户在 --verify 里自己写的（已授权），按 run 的工作目录执行。
 */
export function runVerifyGate(
  verifyCommand: string,
  cwd: string,
  timeoutMs: number = GOAL_MODE.VERIFY_TIMEOUT_MS,
): Promise<VerifyGateResult> {
  return new Promise((resolve) => {
    logger.debug('[GoalGate] running verify command', { verifyCommand, cwd });
    const child = spawn('/bin/sh', ['-c', verifyCommand], { cwd });
    let out = '';
    let timedOut = false;

    const capture = (chunk: Buffer) => {
      if (out.length < GOAL_MODE.VERIFY_OUTPUT_MAX_CHARS) {
        out += chunk.toString();
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.warn('[GoalGate] verify command failed to start', { error: err.message });
      resolve({ pass: false, exitCode: null, output: `验证命令启动失败: ${err.message}`, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const trimmed = out.slice(0, GOAL_MODE.VERIFY_OUTPUT_MAX_CHARS);
      const pass = !timedOut && code === 0;
      logger.debug('[GoalGate] verify finished', { exitCode: code, pass, timedOut });
      resolve({
        pass,
        exitCode: code,
        output: timedOut ? `${trimmed}\n[验证命令超时 ${timeoutMs}ms，已终止]` : trimmed,
        timedOut,
      });
    });
  });
}

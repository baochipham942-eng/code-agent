// ============================================================================
// 闸1：确定性验证闸 —— 直接跑 goal 契约的 verifyCommand，按退出码判定。
// 不经 LLM（不用 Awaiter 子代理）：完成判定要确定性，退出码不看模型脸色，
// 也绕开 transcript 是否可信的问题（见 内部文档 §3）。
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
  command: string;
  cwd: string;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  /**
   * true 仅当验证命令的宿主进程本身没跑起来（cwd 不存在/不是目录、解释器无
   * 执行权限等 OS 级 spawn 失败）——这是"验证基础设施不可用"，不是"验证不过"。
   * 与 exitCode!==null 的正常失败（如 exit 127 命令未解析）是两回事：后者
   * 进程确实执行了 shell，只是命令本身有问题，模型可能靠装依赖/改命令修复；
   * 前者进程根本没起来，模型改代码无从下手。
   */
  spawnFailed: boolean;
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
    const startedAt = Date.now();

    const resolveSpawnFailure = (err: Error) => {
      logger.warn('[GoalGate] verify command failed to start', { error: err.message });
      resolve({
        pass: false,
        exitCode: null,
        output: `验证命令启动失败: ${err.message}`,
        timedOut: false,
        command: verifyCommand,
        cwd,
        durationMs: Date.now() - startedAt,
        stdoutTail: '',
        stderrTail: '',
        spawnFailed: true,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/bin/sh', ['-c', verifyCommand], { cwd });
    } catch (err) {
      // Node 对部分 spawn 参数错误（如 cwd 是文件而非目录 → ENOTDIR）同步抛出而非
      // 走 'error' 事件；这里如果不捕获，Promise executor 里的同步 throw 会让整个
      // Promise reject，上游 runVerificationPlan/goalCompletionGate 都没包
      // try/catch，会直接崩掉整轮 turn 而不是走"验证不过"的正常闸门语义。
      resolveSpawnFailure(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let out = '';
    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    let settled = false;

    const appendTail = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString();
      return next.slice(-GOAL_MODE.VERIFY_OUTPUT_MAX_CHARS);
    };
    const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (out.length < GOAL_MODE.VERIFY_OUTPUT_MAX_CHARS) {
        out += chunk.toString();
      }
      if (stream === 'stdout') {
        stdoutTail = appendTail(stdoutTail, chunk);
      } else {
        stderrTail = appendTail(stderrTail, chunk);
      }
    };
    child.stdout?.on('data', capture('stdout'));
    child.stderr?.on('data', capture('stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Node 文档：child 的 'error' 事件在 spawn 失败 / kill 失败 / send 失败三种
      // 场景都会触发。若 timer 已经判定超时（timedOut 已置位），说明进程确实
      // 跑起来过，这里是 child.kill() 本身失败（如 EPERM）——不能按"进程根本
      // 没起来"处理，否则闸1 会把一次慢测试误判成 infraFailure 走降级放行。
      if (timedOut) {
        const trimmed = out.slice(0, GOAL_MODE.VERIFY_OUTPUT_MAX_CHARS);
        logger.warn('[GoalGate] verify command timed out and kill failed', { error: err.message });
        resolve({
          pass: false,
          exitCode: null,
          output: `${trimmed}\n[验证命令超时 ${timeoutMs}ms，终止失败: ${err.message}]`,
          timedOut: true,
          command: verifyCommand,
          cwd,
          durationMs: Date.now() - startedAt,
          stdoutTail,
          stderrTail,
          spawnFailed: false,
        });
        return;
      }
      resolveSpawnFailure(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = out.slice(0, GOAL_MODE.VERIFY_OUTPUT_MAX_CHARS);
      const pass = !timedOut && code === 0;
      logger.debug('[GoalGate] verify finished', { exitCode: code, pass, timedOut });
      resolve({
        pass,
        exitCode: code,
        output: timedOut ? `${trimmed}\n[验证命令超时 ${timeoutMs}ms，已终止]` : trimmed,
        timedOut,
        command: verifyCommand,
        cwd,
        durationMs: Date.now() - startedAt,
        stdoutTail,
        stderrTail,
        spawnFailed: false,
      });
    });
  });
}

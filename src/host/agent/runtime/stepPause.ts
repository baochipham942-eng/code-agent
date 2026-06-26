// ============================================================================
// stepPause — debug replay --step 用的同步暂停辅助
// 在 agent loop 每个 iteration 末尾按需阻塞等用户回车
// ============================================================================

import readline from 'readline';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('StepPause');

/**
 * 如果 CODE_AGENT_STEP_MODE 启用 + 当前是 TTY，则阻塞等用户回车。
 * 输入 'q' + 回车则 process.exit(0)。
 * 非 TTY（管道、日志重定向）下静默跳过。
 */
export async function maybePauseForStep(turnIndex: number): Promise<void> {
  if (process.env.CODE_AGENT_STEP_MODE !== 'true') return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // 非交互终端跳过，避免管道挂死
    return;
  }

  return new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n[step] turn ${turnIndex} 完成。回车继续，q 退出: `, (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() === 'q') {
        logger.info(`[StepPause] 用户在 turn ${turnIndex} 主动退出`);
        process.exit(0);
      }
      resolve();
    });
  });
}

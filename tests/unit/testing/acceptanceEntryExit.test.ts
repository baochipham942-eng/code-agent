import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// N-EVAL-CI-NOEXIT：真跑入口成功路径必须「打印完结果后显式退出」（#1610 写法：
// stdout flush 后 process.exit）。真跑里数据库/遥测/网络 keep-alive 等常驻句柄
// 让事件循环排不空，没有这个兜底的入口会打印完汇总后挂死（09-03 实录挂 80min）。
// 本测试是 acceptance 普查的门禁化：新增真跑入口必须进名单并带同款收尾，
// 已有入口被改回裸 main().catch 会在这里红。

const ACCEPTANCE_DIR = resolve(
  __dirname,
  '../../../packages/internal/evaluation-center/scripts/acceptance',
);
const EVAL_CI = resolve(
  __dirname,
  '../../../packages/internal/evaluation-center/scripts/eval-ci.ts',
);

// 真跑入口（成功路径必须 flush+exit）：
// - real-agent-replay-eval-smoke.ts：#1610 修
// - agent-trajectory-fresh-sample-smoke.ts / paid-real-model-replay-eval-smoke.ts：本单修
const REAL_RUN_ENTRIES = [
  'real-agent-replay-eval-smoke.ts',
  'agent-trajectory-fresh-sample-smoke.ts',
  'paid-real-model-replay-eval-smoke.ts',
] as const;

// 豁免（不修也不要求 exit）：
// - request-replay-smoke.ts：无 DB/网络长句柄，事件循环能自然排空
// - surface-execution-replay-import-child.ts：子进程入口，生命周期由父进程管理，finally 有 dispose
const EXEMPT_ENTRIES = ['request-replay-smoke.ts', 'surface-execution-replay-import-child.ts'] as const;

const FLUSH_THEN_EXIT = /main\(\)\.then\(\(\) => \{\s*process\.stdout\.write\('', \(\) => process\.exit\(process\.exitCode \?\? 0\)\);?\s*\}\)/;

describe('acceptance 真跑入口成功路径显式退出（N-EVAL-CI-NOEXIT 普查）', () => {
  for (const entry of REAL_RUN_ENTRIES) {
    it(`${entry} 成功路径 flush stdout 后显式退出`, () => {
      const source = readFileSync(resolve(ACCEPTANCE_DIR, entry), 'utf8');
      expect(
        FLUSH_THEN_EXIT.test(source),
        `${entry} 缺少「main().then(stdout flush → process.exit)」成功路径收尾`,
      ).toBe(true);
      // 失败路径语义不动：非零 exit 仍在
      expect(source).toContain('process.exit(1)');
    });
  }

  it('eval-ci.ts 成功路径保持 #1594 flush+exit 兜底（不许撤）', () => {
    const source = readFileSync(EVAL_CI, 'utf8');
    expect(FLUSH_THEN_EXIT.test(source)).toBe(true);
  });

  it('豁免名单仍然豁免（防止误加 exit 改变子进程协议）', () => {
    for (const entry of EXEMPT_ENTRIES) {
      const source = readFileSync(resolve(ACCEPTANCE_DIR, entry), 'utf8');
      expect(FLUSH_THEN_EXIT.test(source), `${entry} 被加了显式退出，请复查是否该进真跑名单`).toBe(false);
    }
  });
});

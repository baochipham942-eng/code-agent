import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// N-EVAL-CI-NOEXIT：真跑入口成功路径必须「打印完结果后显式退出」（#1610 写法：
// stdout flush 后 process.exit）。真跑里数据库/遥测/网络 keep-alive 等常驻句柄
// 让事件循环排不空，没有这个兜底的入口会打印完汇总后挂死（09-03 实录挂 80min）。
// 本测试是 acceptance 普查的门禁化：
//   1. 目录发现——acceptance/ 下任何入口必须在真跑名单或豁免名单里，新增入口不分类就红；
//   2. 静态模式——真跑名单内的入口必须带 flush+exit 收尾（防被改回裸 main().catch）；
//   3. 动态探针——免付费入口真的 spawn 一遍，断言「成功标记打印后进程在时限内 exit 0」。

const REPO_ROOT = resolve(__dirname, '../../..');
const ACCEPTANCE_DIR = resolve(
  REPO_ROOT,
  'packages/internal/evaluation-center/scripts/acceptance',
);
const EVAL_CI = resolve(REPO_ROOT, 'packages/internal/evaluation-center/scripts/eval-ci.ts');

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

describe('acceptance 入口普查：目录发现', () => {
  it('acceptance/ 下每个入口都已分类（真跑名单或豁免名单）', () => {
    const all = readdirSync(ACCEPTANCE_DIR)
      .filter((f) => f.endsWith('.ts'))
      .sort();
    const classified = [...REAL_RUN_ENTRIES, ...EXEMPT_ENTRIES].sort();
    expect(all).toEqual(classified);
  });
});

describe('acceptance 真跑入口成功路径显式退出（静态模式）', () => {
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

// 动态探针：spawn 免付费入口（本地 deterministic 模型 + 临时数据目录，零成本），
// 断言成功标记打印后进程在时限内 exit 0。paid-real-model-replay-eval-smoke 是付费
// 入口（全机只许一条、封顶约束），不进门测，由静态模式 + 付费真跑证据覆盖。
interface ProbeResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  markerAtMs: number | null;
  exitAtMs: number;
  stdoutTail: string;
  stderrTail: string;
}

function probeEntry(entry: string, marker: string, budgetMs: number): Promise<ProbeResult> {
  return new Promise((resolveProbe, rejectProbe) => {
    // vitest setup 给测试进程注入了 CODE_AGENT_CLI_MODE=1（跳过 keytar/sqlite 原生模块）；
    // 探针 spawn 的是真实 CLI 入口，必须剥掉它，否则 better-sqlite3 被禁用、入口起不来。
    const env = { ...process.env };
    delete env.CODE_AGENT_CLI_MODE;
    const child = spawn('npx', ['tsx', resolve(ACCEPTANCE_DIR, entry)], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const startedAt = Date.now();
    let stdoutTail = '';
    let stderrTail = '';
    let markerAtMs: number | null = null;
    let settled = false;
    const killer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        rejectProbe(
          new Error(
            `${entry} 超过 ${budgetMs}ms 未退出（修前挂死形态）` +
              (markerAtMs === null ? '，成功标记也未打印' : `，成功标记已于 ${markerAtMs}ms 打印`) +
              `\nstderr: ${stderrTail.slice(-500)}`,
          ),
        );
      }
    }, budgetMs);
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutTail = (stdoutTail + text).slice(-4000);
      if (markerAtMs === null && stdoutTail.includes(marker)) {
        markerAtMs = Date.now() - startedAt;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(killer);
        rejectProbe(error);
      }
    });
    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(killer);
        resolveProbe({
          code,
          signal,
          markerAtMs,
          exitAtMs: Date.now() - startedAt,
          stdoutTail,
          stderrTail,
        });
      }
    });
  });
}

// 实测值（2026-09-04 本机）：real-agent-replay 24s / agent-trajectory 47s / request-replay 17s。
// 预算取实测 5 倍以上，只拦「挂死」不拦「慢」。
const DYNAMIC_PROBES = [
  { entry: 'real-agent-replay-eval-smoke.ts', marker: 'Real agent replay/eval smoke passed', budgetMs: 180_000 },
  { entry: 'agent-trajectory-fresh-sample-smoke.ts', marker: 'Agent trajectory fresh-sample smoke passed', budgetMs: 300_000 },
  // 对照：豁免入口本就靠事件循环自然排空，探它是为了盯「自然排空」这个前提不回归
  { entry: 'request-replay-smoke.ts', marker: 'request replay smoke passed', budgetMs: 180_000 },
] as const;

// 成功标记打印后，进程须在此窗口内退出（盯的是「打印完还挂着」这种形态）
const EXIT_AFTER_MARKER_MS = 60_000;

describe.sequential('acceptance 入口成功路径退出（动态探针，零成本）', () => {
  for (const { entry, marker, budgetMs } of DYNAMIC_PROBES) {
    it(
      `${entry} 打印成功标记后时限内 exit 0`,
      { timeout: budgetMs + 30_000 },
      async () => {
        const result = await probeEntry(entry, marker, budgetMs);
        expect(result.signal, `${entry} 被信号杀掉（${result.signal}），不是自然退出`).toBeNull();
        expect(result.code, `${entry} 退出码非 0：${result.stderrTail.slice(-800)}`).toBe(0);
        expect(result.markerAtMs, `${entry} 未打印成功标记：${result.stdoutTail.slice(-500)}`).not.toBeNull();
        const afterMarker = result.exitAtMs - (result.markerAtMs ?? 0);
        expect(
          afterMarker,
          `${entry} 成功标记打印后 ${afterMarker}ms 才退出（阈值 ${EXIT_AFTER_MARKER_MS}ms）`,
        ).toBeLessThan(EXIT_AFTER_MARKER_MS);
      },
    );
  }
});

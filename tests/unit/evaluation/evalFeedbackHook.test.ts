import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '', command: '' }));

vi.mock('@host/platform', () => ({ getUserDataPath: () => env.userData }));
vi.mock('@host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ evaluation: { feedbackHookCommand: env.command } }) }),
}));

import { pushEvalFeedback } from '@internal-evaluation/host/evaluation/feedbackHook';

const request = {
  experimentId: 'run-1',
  caseId: 'cases/case 1',
  failureReason: '没生成文件',
  triple: {
    attribution: 'system_config' as const,
    evidence: '代理没配',
    suggestion: '补上代理',
    severity: 'P0' as const,
  },
};

beforeEach(async () => {
  env.userData = await mkdtemp(path.join(os.tmpdir(), 'eval-feedback-'));
  env.command = '';
});

describe('进反馈池钩子（ADR-071 Q4）', () => {
  it('没配命令时只落证据，不执行任何东西；题 id 里的斜杠不会把证据写出目录', async () => {
    const result = await pushEvalFeedback(request, 1_700_000_000_000);
    expect(result.hookRan).toBe(false);
    expect(path.dirname(path.dirname(result.evidenceDir))).toBe(env.userData);
    expect(await readdir(result.evidenceDir)).toEqual(['evidence.json']);
    expect(JSON.parse(await readFile(path.join(result.evidenceDir, 'evidence.json'), 'utf8'))).toMatchObject({
      caseId: 'cases/case 1',
      runId: 'run-1',
      attribution: 'system_config',
      severity: 'P0',
      evidence: '代理没配',
    });
  });

  it('同一题同一毫秒推两次各落各的目录，不互相覆盖', async () => {
    const now = 1_700_000_000_000;
    const [first, second] = await Promise.all([
      pushEvalFeedback(request, now),
      pushEvalFeedback(request, now),
    ]);
    expect(first.evidenceDir).not.toBe(second.evidenceDir);
    expect((await readdir(env.userData))[0]).toBeTruthy();
    expect(await readdir(path.join(env.userData, 'eval-feedback'))).toHaveLength(2);
  });

  it('钩子跑挂了不丢证据：hookRan=false + hookError，证据目录照样报回去', async () => {
    env.command = 'exit 3';
    const result = await pushEvalFeedback(request, 1_700_000_000_000);
    expect(result.hookRan).toBe(false);
    expect(result.hookError).toBeTruthy();
    expect(await readdir(result.evidenceDir)).toEqual(['evidence.json']);
  });

  it('配了命令就执行，证据目录经环境变量传入而不是拼进命令串', async () => {
    env.command = 'printf "%s" "$NEO_EVAL_FEEDBACK_DIR"';
    const result = await pushEvalFeedback(request, 1_700_000_000_000);
    expect(result.hookRan).toBe(true);
    expect(result.output).toBe(result.evidenceDir);
  });
});

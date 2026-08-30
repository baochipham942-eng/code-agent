import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// 2026-08-30 监工代笔（Grok 变异席抓出的盲区）：生产探针 evalRunPanelProbe.ts 用 promptHash 判
// 「提示词改过 ⇒ 回未校准」，但改内置提示词一个字 6 文件 28/28 仍绿——探针测试全 mock 掉了
// inspectEvalRunPanel。这里走真探针 + 真登记文件：① 冻结当前 task_completed 提示词 hash 的登记
// 必须判 calibrated（改提示词就红，逼人重校准并更新这个常量）；② hash 不符必须判 prompt_changed。
const FROZEN_TASK_COMPLETED_PROMPT_HASH = 'd609345b10709e47137d0f584d84f122a9b6dbc4f4cea94be3d9f6b7a3e40093';

const probeEnv = vi.hoisted(() => ({ repositoryRoot: '' }));

vi.mock('@internal-evaluation/host/evaluation/evalEnvironment', () => ({
  inspectEvalEnvironment: () => ({
    available: true,
    message: '',
    packaged: false,
    platform: 'darwin',
    osJail: { enabled: false, available: false, active: false },
    repositoryRoot: probeEnv.repositoryRoot,
  }),
}));
vi.mock('../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({ model: 'deepseek-chat', provider: 'deepseek' }),
}));
vi.mock('../../../src/host/model/quickModel', () => ({
  getQuickModelRuntimeInfo: () => ({ provider: 'judge-provider', model: 'judge-model', baseUrl: 'https://judge.example/v1' }),
}));

import { inspectEvalRunPanel } from '@internal-evaluation/host/evaluation/evalRunPanelProbe';
import { saveCalibrationRecord, type JudgeCalibrationRecord } from '../../../src/host/testing/calibration/calibrationRegistry';
import { getAiReviewPromptHash } from '../../../src/host/testing/judge/dimensionJudge';

async function registryWith(promptHash: string): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-probe-calib-'));
  const dir = path.join(root, '.code-agent');
  await mkdir(dir, { recursive: true });
  const record: JudgeCalibrationRecord = {
    standardVersion: 2,
    dimension: 'task_completed',
    judgeId: 'task_completed@judge-provider/judge-model',
    promptHash,
    endpoint: 'https://judge.example/v1',
    judgeModel: 'judge-provider/judge-model',
    datasetFingerprint: 'sha256:fixture',
    goldSource: 'deterministic_shadow',
    kappa: 0.7,
    agreementRate: 0.85,
    pairs: 50,
    falsePositiveRate: 0.1,
    computedAt: '2026-08-30T00:00:00.000Z',
  };
  await saveCalibrationRecord(dir, record);
  probeEnv.repositoryRoot = root;
}

describe('打分器探针 · 提示词 hash 是校准态的真判据', () => {
  it('内置提示词未变（hash 与冻结快照一致）⇒ task_completed 判已校准', async () => {
    expect(getAiReviewPromptHash('task_completed'), '内置提示词变了：要么回退，要么重校准并更新冻结 hash').toBe(FROZEN_TASK_COMPLETED_PROMPT_HASH);
    await registryWith(FROZEN_TASK_COMPLETED_PROMPT_HASH);
    const probe = await inspectEvalRunPanel();
    const dim = probe.aiReview.find((item) => item.dim === 'task_completed');
    expect(dim?.calibration).toMatchObject({ state: 'calibrated', kappa: 0.7, pairs: 50 });
  });

  it('登记的 promptHash 与当前内置提示词不符 ⇒ 回未校准，理由 prompt_changed', async () => {
    await registryWith('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    const probe = await inspectEvalRunPanel();
    const dim = probe.aiReview.find((item) => item.dim === 'task_completed');
    expect(dim?.calibration).toMatchObject({ state: 'uncalibrated', reason: 'prompt_changed' });
  });

  it('T5：不会跑的题数包含根目录与 drafts 下的题', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-probe-case-bank-'));
    const bank = path.join(root, '.claude', 'test-cases');
    const drafts = path.join(bank, 'drafts');
    await mkdir(drafts, { recursive: true });
    const yaml = (id: string) => [
      `name: ${id}-suite`,
      'cases:',
      `  - id: ${id}`,
      '    type: task',
      `    prompt: ${id}`,
      '    expect: {}',
      '',
    ].join('\n');
    await writeFile(path.join(bank, 'normal.yaml'), yaml('normal-missing'));
    await writeFile(path.join(drafts, 'draft-one.yaml'), yaml('draft-one'));
    await writeFile(path.join(drafts, 'draft-two.yaml'), yaml('draft-two'));
    probeEnv.repositoryRoot = root;

    const probe = await inspectEvalRunPanel();

    expect(probe.unhardenedCount).toBe(3);
  });
});

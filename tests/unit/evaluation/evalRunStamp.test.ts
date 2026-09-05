import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVAL_RUN_STAMP_KEYS,
  UNKNOWN_EVAL_RUN_STAMP,
  type EvalRunStamp,
} from '../../../src/shared/contract/evaluation';
import { MODEL_PRICING_PER_1M } from '../../../src/shared/constants/pricing';
import { resolveProductionShape } from '@internal-evaluation/host/evaluation/productionShape';
import { EVAL_AGENT_DEFAULTS } from '../../../src/host/testing/agentAdapter';
import { EVAL_GOAL_ALLOW_SWARM } from '../../../src/host/testing/goalContractEval';
import {
  buildRunStamp,
  loadApiKey,
} from '@internal-evaluation-scripts/lib/eval-run-stamp';
import { estimateCostPerCase } from '@internal-evaluation-scripts/lib/eval-cost-estimate';

const roots: string[] = [];

afterEach(async () => {
  delete process.env.RUNSTAMP_API_KEY;
  delete process.env.NEO_EVAL_ANSWERS_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function createGitRepo(): Promise<{ root: string; caseDir: string; answerRoot: string; answerFile: string; splitFile: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-runstamp-repo-'));
  roots.push(root);
  const caseDir = path.join(root, '.claude', 'test-cases');
  const answerRoot = path.join(root, 'private-eval');
  const answerFile = path.join(answerRoot, 'answers', '.claude', 'test-cases', 'x.yaml');
  const splitFile = path.join(answerRoot, 'eval-splits.json');
  await mkdir(caseDir, { recursive: true });
  await mkdir(path.dirname(answerFile), { recursive: true });
  await writeFile(path.join(caseDir, 'x.yaml'), 'name: x\ncases: []\n');
  await writeFile(answerFile, 'version: 1\nsource: .claude/test-cases/x.yaml\ncases: []\n');
  await writeFile(splitFile, '{"heldIn":[]}\n');
  process.env.NEO_EVAL_ANSWERS_DIR = answerRoot;
  git(root, ['init', '-q']);
  git(root, ['add', '.claude/test-cases']);
  git(root, ['-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.com', 'commit', '-qm', 'fixture']);
  return { root, caseDir, answerRoot, answerFile, splitFile };
}

function stampOptions(
  root: string,
  caseDir: string,
  shape: EvalRunStamp['shape'] = {
    skills: [...EVAL_AGENT_DEFAULTS.skills],
    plugins: [],
    memory: EVAL_AGENT_DEFAULTS.persistLongTermMemory,
    swarm: EVAL_GOAL_ALLOW_SWARM,
    harness: null,
  },
) {
  return {
    workingDir: root,
    testCaseDir: caseDir,
    mode: 'mock' as const,
    provider: 'mock',
    model: 'mock-model',
    split: 'held-in' as const,
    judge: 'rules' as const,
    shape,
    estimatedCases: 1,
  };
}

describe('eval run stamp', () => {

  it('EVAL_RUN_STAMP_KEYS is exhaustive over EvalRunStamp (2026-08-29 Grok 变异席盲区：删 k 仍绿)', () => {
    expect([...EVAL_RUN_STAMP_KEYS].sort()).toEqual(Object.keys(UNKNOWN_EVAL_RUN_STAMP).sort());
  });
  it('records every required key and tracks case-bank dirtiness and external directories', async () => {
    const { root, caseDir, answerFile, splitFile } = await createGitRepo();
    const clean = buildRunStamp(stampOptions(root, caseDir));

    for (const key of EVAL_RUN_STAMP_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(clean, key), key).toBe(true);
      expect(clean[key], key).not.toBeUndefined();
      expect(clean[key], key).not.toBeNull();
    }
    expect(clean.caseBankSha).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.answerSideSha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(clean.evalSet.splitsFileSha).toMatch(/^sha256:[0-9a-f]{64}$/);

    await writeFile(answerFile, 'version: 1\nsource: .claude/test-cases/x.yaml\ncases: [{ id: changed, expect: { no_crash: true } }]\n');
    expect(buildRunStamp(stampOptions(root, caseDir)).answerSideSha).not.toBe(clean.answerSideSha);
    await writeFile(splitFile, '{"heldIn":["changed"]}\n');
    expect(buildRunStamp(stampOptions(root, caseDir)).evalSet.splitsFileSha).not.toBe(clean.evalSet.splitsFileSha);

    await writeFile(path.join(caseDir, 'x.yaml'), 'name: changed\ncases: []\n');
    expect(buildRunStamp(stampOptions(root, caseDir)).caseBankSha).toMatch(/^[0-9a-f]{40}-dirty$/);

    const external = await mkdtemp(path.join(os.tmpdir(), 'eval-runstamp-external-'));
    roots.push(external);
    expect(buildRunStamp(stampOptions(root, external)).caseBankSha).toBe('untracked');
  });

  it('uses the shared price table for the five-thousand-token estimate', () => {
    const pricing = MODEL_PRICING_PER_1M['deepseek-chat'];
    expect(estimateCostPerCase('deepseek-chat')).toBe(
      (pricing.input + pricing.output) * 5_000 / 1_000_000,
    );
  });

  it('derives production differences instead of writing them as constants', async () => {
    const { root, caseDir } = await createGitRepo();
    const production = resolveProductionShape('mock-model');
    const evalStamp = buildRunStamp(stampOptions(root, caseDir));
    expect(evalStamp.divergesFromProduction).toContain('memory');

    // eval 默认不起插件系统 ⇒ 插件面与生产默认不同，这是本轮形态的真实读数
    expect(evalStamp.divergesFromProduction).toContain('plugins');
    expect(production.plugins.length).toBeGreaterThan(0);

    const memoryAligned = buildRunStamp(stampOptions(root, caseDir, {
      skills: [],
      plugins: [...production.plugins],
      memory: production.memory,
      swarm: false,
      harness: null,
    }));
    expect(memoryAligned.divergesFromProduction).not.toContain('memory');
    expect(memoryAligned.divergesFromProduction).not.toContain('plugins');
  });

  it('records only the API-key source for env, project file, and home file', async () => {
    const { root, caseDir } = await createGitRepo();
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'eval-runstamp-home-'));
    roots.push(fakeHome);
    const secret = 'sk-test-runstamp-secret';

    process.env.RUNSTAMP_API_KEY = secret;
    expect(loadApiKey('runstamp', root, fakeHome)?.source).toBe('env:RUNSTAMP_API_KEY');
    delete process.env.RUNSTAMP_API_KEY;

    await writeFile(path.join(root, '.env'), `RUNSTAMP_API_KEY=${secret}\n`);
    expect(loadApiKey('runstamp', root, fakeHome)?.source).toBe(`file:${path.join(root, '.env')}`);
    const stamp = buildRunStamp({
      ...stampOptions(root, caseDir),
      mode: 'real',
      provider: 'runstamp',
      model: 'deepseek-chat',
    });
    expect(JSON.stringify(stamp)).not.toContain(secret);

    await unlink(path.join(root, '.env'));
    await mkdir(path.join(fakeHome, '.code-agent'), { recursive: true });
    await writeFile(path.join(fakeHome, '.code-agent', '.env'), `RUNSTAMP_API_KEY=${secret}\n`);
    expect(loadApiKey('runstamp', root, fakeHome)?.source).toBe('file:~/.code-agent/.env');
  });
});

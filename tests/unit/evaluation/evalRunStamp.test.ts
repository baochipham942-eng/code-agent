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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function createGitRepo(): Promise<{ root: string; caseDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-runstamp-repo-'));
  roots.push(root);
  const caseDir = path.join(root, '.claude', 'test-cases');
  await mkdir(caseDir, { recursive: true });
  await writeFile(path.join(caseDir, 'x.yaml'), 'name: x\ncases: []\n');
  await writeFile(path.join(root, '.claude', 'eval-splits.json'), '{"heldIn":[]}\n');
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.com', 'commit', '-qm', 'fixture']);
  return { root, caseDir };
}

function stampOptions(
  root: string,
  caseDir: string,
  shape: EvalRunStamp['shape'] = {
    skills: [...EVAL_AGENT_DEFAULTS.skills],
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
    const { root, caseDir } = await createGitRepo();
    const clean = buildRunStamp(stampOptions(root, caseDir));

    for (const key of EVAL_RUN_STAMP_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(clean, key), key).toBe(true);
      expect(clean[key], key).not.toBeUndefined();
      expect(clean[key], key).not.toBeNull();
    }
    expect(clean.caseBankSha).toMatch(/^[0-9a-f]{40}$/);

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

    const memoryAligned = buildRunStamp(stampOptions(root, caseDir, {
      skills: [],
      memory: production.memory,
      swarm: false,
      harness: null,
    }));
    expect(memoryAligned.divergesFromProduction).not.toContain('memory');
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

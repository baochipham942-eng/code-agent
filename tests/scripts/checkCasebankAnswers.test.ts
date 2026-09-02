import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const gateScript = path.join(repoRoot, 'scripts', 'ci', 'check-casebank-answers.mjs');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  answerRoot: string;
  publicPath: string;
  answerPath: string;
  splitPath: string;
  publicSuite: { name: string; default_max_cost_usd: number; cases: Array<Record<string, unknown>> };
  answerFile: { version: 1; source: string; cases: Array<Record<string, unknown>> };
  split: { version: 1; seed: string; createdAt: string; heldIn: string[]; heldOut: string[]; control: string[]; safety: string[] };
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'casebank-answer-gate-'));
  roots.push(root);
  const answerRoot = path.join(root, 'private-eval');
  const source = '.claude/test-cases/core.yaml';
  const publicPath = path.join(root, ...source.split('/'));
  const answerPath = path.join(answerRoot, 'answers', ...source.split('/'));
  const splitPath = path.join(answerRoot, 'eval-splits.json');
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.mkdir(path.dirname(publicPath), { recursive: true });
  await fs.mkdir(path.dirname(answerPath), { recursive: true });

  const ids = Array.from({ length: 140 }, (_, index) => `case-${String(index + 1).padStart(3, '0')}`);
  const safety = ids.slice(0, 12);
  const heldIn = ids.slice(12);
  const publicSuite = {
    name: 'gate fixture',
    default_max_cost_usd: 0.10,
    cases: ids.map((id, index) => ({
      id,
      type: 'task',
      prompt: id,
      ...(index < 12 ? { category: 'security' } : {}),
    })),
  };
  const answerFile = {
    version: 1 as const,
    source,
    cases: ids.map((id) => ({ id, expect: { no_crash: true } })),
  };
  const split = {
    version: 1 as const,
    seed: 'gate-fixture',
    createdAt: '2026-09-02',
    heldIn,
    heldOut: [],
    control: [heldIn[0]],
    safety,
  };
  await Promise.all([
    fs.writeFile(publicPath, JSON.stringify(publicSuite)),
    fs.writeFile(answerPath, JSON.stringify(answerFile)),
    fs.writeFile(splitPath, JSON.stringify(split)),
  ]);
  return { root, answerRoot, publicPath, answerPath, splitPath, publicSuite, answerFile, split };
}

function runGate(target: Fixture) {
  return spawnSync(process.execPath, [gateScript, '--require-private'], {
    cwd: target.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NEO_EVAL_ANSWERS_DIR: target.answerRoot,
      TSX_TSCONFIG_PATH: path.join(repoRoot, 'tsconfig.json'),
    },
  });
}

describe('check-casebank-answers gate', () => {
  it('公开 YAML 塞一条非空 expect 时公开模式变红', async () => {
    const target = await fixture();
    target.publicSuite.cases[20].expect = { no_crash: true };
    await fs.writeFile(target.publicPath, JSON.stringify(target.publicSuite));

    const result = spawnSync(process.execPath, [gateScript], { cwd: target.root, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('公开仓存在非空 expect');
  });

  it('私档删一条答案时本地模式变红', async () => {
    const target = await fixture();
    target.answerFile.cases.splice(20, 1);
    await fs.writeFile(target.answerPath, JSON.stringify(target.answerFile));

    const result = runGate(target);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('缺少公开题答案 case-021');
  });

  it('私档多一个孤儿 id 时本地模式变红', async () => {
    const target = await fixture();
    target.answerFile.cases.push({ id: 'orphan-case', expect: { no_crash: true } });
    await fs.writeFile(target.answerPath, JSON.stringify(target.answerFile));

    const result = runGate(target);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('私档孤儿 id orphan-case');
  });

  it('splits 漏一个 id 时本地模式变红', async () => {
    const target = await fixture();
    target.split.heldIn.splice(5, 1);
    await fs.writeFile(target.splitPath, JSON.stringify(target.split));

    const result = runGate(target);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('split is missing case ids');
  });
});

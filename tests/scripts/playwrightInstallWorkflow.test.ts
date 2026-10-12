import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { load as loadYaml } from 'js-yaml';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const workflowsDir = path.join(repoRoot, '.github/workflows');
const COMPOSITE = '.github/actions/setup-playwright';

type WorkflowStep = {
  name?: string;
  run?: unknown;
  uses?: unknown;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type WorkflowFile = {
  jobs?: Record<string, WorkflowJob>;
};

function workflowPaths(): string[] {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => path.join(workflowsDir, name));
}

function loadWorkflow(file: string): WorkflowFile {
  return loadYaml(readFileSync(file, 'utf8')) as WorkflowFile;
}

function stepsOf(doc: WorkflowFile): WorkflowStep[] {
  return Object.values(doc.jobs ?? {}).flatMap((job) => job?.steps ?? []);
}

function isSetupPlaywright(step: WorkflowStep): boolean {
  return typeof step.uses === 'string' && step.uses.includes(COMPOSITE);
}

function wantsDeps(step: WorkflowStep): boolean {
  const value = step.with?.['with-deps'];
  return value === true || value === 'true';
}

describe('Playwright install lives in the composite action', () => {
  it('fails when a workflow step outside the composite runs playwright install', () => {
    const offenders: string[] = [];
    for (const file of workflowPaths()) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      const doc = loadWorkflow(file);
      for (const step of stepsOf(doc)) {
        if (typeof step.run === 'string' && step.run.includes('playwright install')) {
          offenders.push(`${rel}: ${step.name ?? '(unnamed step)'}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('routes every former install site through setup-playwright, preserving --with-deps', () => {
    const byFile = new Map<string, WorkflowStep[]>();
    for (const file of workflowPaths()) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      byFile.set(rel, stepsOf(loadWorkflow(file)).filter(isSetupPlaywright));
    }

    const swarm = byFile.get('.github/workflows/swarm-ci.yml') ?? [];
    const main = byFile.get('.github/workflows/main-full-gate.yml') ?? [];
    const scroll = byFile.get('.github/workflows/long-session-scroll-gate.yml') ?? [];
    expect(swarm).toHaveLength(4);
    expect(swarm.every(wantsDeps)).toBe(true);
    expect(main).toHaveLength(1);
    expect(main.some(wantsDeps)).toBe(false);
    expect(scroll).toHaveLength(1);
    expect(scroll.some(wantsDeps)).toBe(false);

    const otherUses = [...byFile.entries()]
      .filter(([rel]) => ![
        '.github/workflows/swarm-ci.yml',
        '.github/workflows/main-full-gate.yml',
        '.github/workflows/long-session-scroll-gate.yml',
      ].includes(rel))
      .flatMap(([, steps]) => steps);
    expect(otherUses).toEqual([]);

    const action = readFileSync(path.join(repoRoot, COMPOSITE, 'action.yml'), 'utf8');
    expect(action).toContain('actions/cache@v4');
    expect(action).toContain('~/.cache/ms-playwright');
    expect(action).toContain('-v2');
    expect(action).toContain('npx playwright install --with-deps chromium');
    expect(action).toContain('npx playwright install chromium');
    expect(action).not.toContain('cache-hit');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RELEASE_EVIDENCE_GATE_WORKFLOW,
  RELEASE_EVIDENCE_PRODUCERS,
} from '../../scripts/lib/releaseEvidenceRegistry.ts';
import {
  checkReleaseEvidenceRegistry,
  evidenceAccountingErrors,
  evidencePathsInSource,
  scanEvidenceOutputs,
  workflowPathsErrors,
} from '../../scripts/ci/check-release-evidence-registry.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const workspaces: string[] = [];

function createWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-evidence-registry-'));
  workspaces.push(root);
  return root;
}

function writeScript(root: string, relativePath: string, source: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) fs.rmSync(workspace, { recursive: true, force: true });
});

describe('release evidence registry gate', () => {
  it('accounts for every evidence output in this repository', () => {
    const errors = checkReleaseEvidenceRegistry(REPO_ROOT);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  // 承重判据：反向的。新增产出脚本却不登记 → 报红并点名；不新增 → 干净。
  it('fails closed on an unregistered evidence producer and clears once it is gone', () => {
    const root = createWorkspace();
    writeScript(root, 'scripts/acceptance/fake-smoke.ts', `
      const REPORT = 'docs/stability/fake-latest.json';
      export default REPORT;
    `);

    const unregistered = evidenceAccountingErrors(scanEvidenceOutputs(root))
      .filter((error) => error.startsWith('unregistered release evidence output'));
    expect(unregistered).toEqual([
      expect.stringContaining('docs/stability/fake-latest.json') as unknown as string,
    ]);
    expect(unregistered[0]).toContain('scripts/acceptance/fake-smoke.ts');

    fs.rmSync(path.join(root, 'scripts/acceptance/fake-smoke.ts'));
    writeScript(root, 'scripts/acceptance/harmless.ts', 'export const noop = true;\n');
    expect(
      evidenceAccountingErrors(scanEvidenceOutputs(root))
        .filter((error) => error.startsWith('unregistered release evidence output')),
    ).toEqual([]);
  });

  // #1047 的坑：long-session 的路径是 OUT_DIR + 文件名两段拼的，
  // 按完整字面量扫扫不到它——而它恰恰是最容易漏登记的那一类。
  it('reconstructs evidence paths built from a directory constant plus a file name', () => {
    const source = `
      const OUT_DIR = path.resolve(process.cwd(), 'docs/perf');
      const JSON_OUT = path.join(OUT_DIR, 'two-part-latest.json');
    `;
    expect(evidencePathsInSource(source)).toContain('docs/perf/two-part-latest.json');

    const scan = scanEvidenceOutputs(REPO_ROOT);
    const longSession = RELEASE_EVIDENCE_PRODUCERS.find((entry) => entry.shape === 'long-session');
    expect(scan.outputs.get(longSession?.evidence ?? '')).toContain(longSession?.producer);
  });

  // 门要能报告自己的盲区：扫描范围空掉时报红，而不是「零违规」的完美假绿
  it('reports a broken scan scope instead of passing on zero candidates', () => {
    const errors = evidenceAccountingErrors(scanEvidenceOutputs(createWorkspace()));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('the scan scope itself is broken');
  });

  it('reports registered evidence that the scan can no longer rediscover', () => {
    const root = createWorkspace();
    writeScript(root, 'scripts/acceptance/harmless.ts', 'export const noop = true;\n');
    const errors = evidenceAccountingErrors(scanEvidenceOutputs(root));
    for (const entry of RELEASE_EVIDENCE_PRODUCERS) {
      expect(errors.join('\n')).toContain(`registered evidence ${entry.evidence} was not rediscovered`);
    }
  });

  it('reports workflow paths that drifted from the registry', () => {
    const root = createWorkspace();
    const workflow = fs.readFileSync(path.join(REPO_ROOT, RELEASE_EVIDENCE_GATE_WORKFLOW), 'utf8');
    expect(workflowPathsErrors(REPO_ROOT)).toEqual([]);

    writeScript(root, RELEASE_EVIDENCE_GATE_WORKFLOW, workflow.replaceAll("- 'scripts/**'", "- 'scripts/acceptance/**'"));
    const drifted = workflowPathsErrors(root);
    expect(drifted).toHaveLength(2);
    expect(drifted[0]).toContain('drifted from the registry');
  });

  it('reports missing generated markers instead of silently skipping the check', () => {
    const root = createWorkspace();
    const workflow = fs.readFileSync(path.join(REPO_ROOT, RELEASE_EVIDENCE_GATE_WORKFLOW), 'utf8');
    writeScript(root, RELEASE_EVIDENCE_GATE_WORKFLOW, workflow.replaceAll('# END generated-paths', ''));
    expect(workflowPathsErrors(root)[0]).toContain('must contain exactly 2 generated paths blocks');
  });
});

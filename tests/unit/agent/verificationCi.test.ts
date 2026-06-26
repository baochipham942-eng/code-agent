import { describe, expect, it } from 'vitest';
import { buildVerificationCard } from '../../../src/host/agent/verification';
import { attributeCiFailure, ingestCiLogEvidence } from '../../../src/host/agent/verificationCi';

describe('CI log verification ingest', () => {
  const log = [
    'Job build-and-test',
    '##[group]Run npm run typecheck',
    '> code-agent@0.20.0 typecheck',
    'src/host/foo.ts(12,7): error TS2322: Type string is not assignable to type number.',
    'Error: Process completed with exit code 2.',
  ].join('\n');

  it('attributes failing job, step, command, files, and failure type', () => {
    const attribution = attributeCiFailure({
      source: 'github-actions:run-42',
      runUrl: 'https://github.com/acme/repo/actions/runs/42',
      logText: log,
      capturedAtMs: 1,
    });

    expect(attribution).toMatchObject({
      failingJob: 'Job build-and-test',
      failingStep: 'npm run typecheck',
      command: 'npm run typecheck',
      failureType: 'typecheck',
      candidateFiles: ['src/host/foo.ts'],
    });
    expect(attribution.topErrorLines).toEqual(expect.arrayContaining([
      expect.stringContaining('TS2322'),
    ]));
    expect(attribution.evidenceRef).toMatchObject({
      kind: 'ci',
      source: 'ci-log-ingest',
      freshness: expect.objectContaining({ state: 'read' }),
    });
  });

  it('maps CI attribution into VerificationEvidence and card counts', () => {
    const evidence = ingestCiLogEvidence({
      source: 'github-actions:run-42',
      logText: log,
      capturedAtMs: 1,
    });
    const card = buildVerificationCard(evidence);

    expect(evidence.status).toBe('failed');
    expect(evidence.commandResults[0]).toMatchObject({
      kind: 'ci',
      pass: false,
      command: 'npm run typecheck',
    });
    expect(card).toMatchObject({
      status: 'failed',
      failureType: 'typecheck',
      requiredStatus: 'failed',
      counts: { passed: 0, failed: 1, notRun: 0, total: 1 },
    });
    expect(card.evidenceRefIds).toEqual([evidence.evidenceRefs[0]?.id]);
  });
});

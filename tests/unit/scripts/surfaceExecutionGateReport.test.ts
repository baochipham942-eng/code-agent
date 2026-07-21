import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  artifactRequirementKey,
  evaluateSurfaceGateReport,
  SURFACE_COMPLETION_ROWS,
  SURFACE_GATE_PROOF_PATHS,
  SURFACE_T0_GATES,
  SURFACE_T1_GATES,
  validateEvidenceBackedDefer,
  type ArtifactRequirement,
  type LoadedSurfaceProof,
  type SurfaceGateDefinition,
  type SurfaceGateEvaluationInput,
  type SurfaceGateProofId,
} from '../../../scripts/acceptance/surface-execution-gate-report-core.ts';
import { loadProof } from '../../../scripts/acceptance/surface-execution-gate-report.ts';
import type {
  SurfaceAcceptanceSourceFingerprintV1,
} from '../../../scripts/acceptance/surface-execution-proof.ts';

const fingerprint: SurfaceAcceptanceSourceFingerprintV1 = {
  version: 1,
  algorithm: 'sha256',
  sha256: 'a'.repeat(64),
  head: 'b'.repeat(40),
  dirty: true,
  dirtyPaths: ['src/example.ts'],
  scopes: ['src'],
};

const campaign = {
  id: 'surface-campaign-20260721',
  startedAt: '2026-07-21T00:00:00.000Z',
};

const basicGate: SurfaceGateDefinition = {
  id: 'test-gate',
  title: 'test gate',
  bindings: [{ proof: 'managed', assertions: ['verified'] }],
};

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function artifactFixture(
  declaredPath: string,
  content: string,
): { root: string; proofDirectory: string; requirement: ArtifactRequirement } {
  const root = mkdtempSync(join(tmpdir(), 'surface-gate-artifact-'));
  const proofPath = join(root, SURFACE_GATE_PROOF_PATHS.managed);
  const proofDirectory = dirname(proofPath);
  mkdirSync(proofDirectory, { recursive: true });
  writeFileSync(proofPath, JSON.stringify({
    evidence: {
      artifact: {
        path: declaredPath,
        sha256: sha256(content),
        bytes: Buffer.byteLength(content),
      },
    },
  }));
  return {
    root,
    proofDirectory,
    requirement: { recordPath: 'evidence.artifact' },
  };
}

function proof(
  id: SurfaceGateProofId,
  document: Record<string, unknown> = {},
): LoadedSurfaceProof {
  return {
    id,
    path: SURFACE_GATE_PROOF_PATHS[id],
    document: {
      version: 1,
      status: 'passed',
      sourceFingerprint: fingerprint,
      assertions: { verified: true },
      ...document,
    },
  };
}

function allProofs(): Record<SurfaceGateProofId, LoadedSurfaceProof> {
  return Object.fromEntries(
    (Object.keys(SURFACE_GATE_PROOF_PATHS) as SurfaceGateProofId[])
      .map((id) => [id, proof(id)]),
  ) as Record<SurfaceGateProofId, LoadedSurfaceProof>;
}

function allCampaignProofs(): Record<SurfaceGateProofId, LoadedSurfaceProof> {
  const proofs = allProofs();
  for (const candidate of Object.values(proofs)) {
    candidate.proofFileMtimeMs = Date.parse('2026-07-21T00:00:01.000Z');
    Object.assign(candidate.document as Record<string, unknown>, {
      campaign: { ...campaign },
      recordedAt: '2026-07-21T00:00:01.000Z',
    });
  }
  return proofs;
}

function input(overrides: Partial<SurfaceGateEvaluationInput> = {}): SurfaceGateEvaluationInput {
  return {
    generatedAt: '2026-07-21T00:00:05.000Z',
    truthSource: 'docs/plans/surface.md',
    invocation: ['npx', 'tsx', 'gate-report.ts', '--out', '/tmp/report.json'],
    currentSourceFingerprint: fingerprint,
    git: {
      worktree: '/tmp/worktree',
      head: fingerprint.head,
      originMain: 'c'.repeat(40),
      mergeBase: 'c'.repeat(40),
      commands: [],
    },
    proofs: allProofs(),
    t0: [basicGate],
    t1: [],
    completionRows: [{
      phase: 'P0',
      id: 'p0-test',
      title: 'P0 test',
      gateIds: ['test-gate'],
    }],
    ...overrides,
  };
}

describe('Surface Execution fail-closed gate report', () => {
  it('passes only when proof status, boolean assertion, fingerprint, artifact, and readback agree', () => {
    const requirement: ArtifactRequirement = { recordPath: 'evidence.screenshot' };
    const proofs = allProofs();
    proofs.managed = proof('managed', {
      assertions: { verified: true },
      evidence: {
        readback: 'Business state verified',
        screenshot: { path: 'business.png', sha256: 'd'.repeat(64), bytes: 128 },
      },
    });
    proofs.managed.artifactFacts = {
      [artifactRequirementKey(requirement)]: [{
        declaredPath: 'business.png',
        resolvedPath: '/tmp/worktree/proof/business.png',
        expectedSha256: 'd'.repeat(64),
        expectedBytes: 128,
        exists: true,
        insideProofDirectory: true,
        actualSha256: 'd'.repeat(64),
        actualBytes: 128,
      }],
    };
    const gate: SurfaceGateDefinition = {
      id: 'artifact-gate',
      title: 'artifact gate',
      bindings: [{
        proof: 'managed',
        assertions: ['verified'],
        artifacts: [requirement],
        readbacks: ['evidence.readback'],
      }],
    };
    const report = evaluateSurfaceGateReport(input({
      proofs,
      t0: [gate],
      completionRows: [{
        phase: 'P0',
        id: 'p0-artifact',
        title: 'P0 artifact',
        gateIds: ['artifact-gate'],
      }],
    }));

    expect(report.overall).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(report.t0[0].status).toBe('passed');
  });

  it('marks a proof stale when the recorded source fingerprint is not exactly current', () => {
    const proofs = allProofs();
    proofs.relay = proof('relay', {
      sourceFingerprint: { ...fingerprint, sha256: 'e'.repeat(64) },
    });
    const report = evaluateSurfaceGateReport(input({ proofs }));

    expect(report.proofInventory.find((item) => item.id === 'relay')?.status).toBe('stale');
    expect(report.overall).toMatchObject({ status: 'stale', exitCode: 1 });
  });

  it('marks a proof stale when its campaign does not exactly match', () => {
    const proofs = allCampaignProofs();
    const relayDocument = proofs.relay.document as Record<string, unknown>;
    relayDocument.campaign = { ...campaign, id: 'different-campaign' };

    const report = evaluateSurfaceGateReport(input({ proofs, campaign }));

    expect(report.proofInventory.find((item) => item.id === 'relay')).toMatchObject({
      status: 'stale',
      issues: [expect.stringContaining('does not exactly match')],
    });
    expect(report.overall).toMatchObject({ status: 'stale', exitCode: 1 });
  });

  it('marks a proof stale when the requested campaign metadata is missing', () => {
    const proofs = allCampaignProofs();
    const relayDocument = proofs.relay.document as Record<string, unknown>;
    delete relayDocument.campaign;

    const report = evaluateSurfaceGateReport(input({ proofs, campaign }));

    expect(report.proofInventory.find((item) => item.id === 'relay')).toMatchObject({
      status: 'stale',
      issues: [expect.stringContaining('does not exactly match')],
    });
    expect(report.overall.exitCode).toBe(1);
  });

  it('marks a proof stale when a root timestamp predates the campaign', () => {
    const proofs = allCampaignProofs();
    const relayDocument = proofs.relay.document as Record<string, unknown>;
    relayDocument.recordedAt = '2026-07-20T23:59:59.999Z';

    const report = evaluateSurfaceGateReport(input({ proofs, campaign }));

    expect(report.proofInventory.find((item) => item.id === 'relay')).toMatchObject({
      status: 'stale',
      issues: [expect.stringContaining('predates')],
    });
    expect(report.overall.exitCode).toBe(1);
  });

  it('marks a proof stale when a root timestamp is beyond report clock-skew tolerance', () => {
    const proofs = allCampaignProofs();
    const relayDocument = proofs.relay.document as Record<string, unknown>;
    relayDocument.recordedAt = '2026-07-21T00:00:08.000Z';

    const report = evaluateSurfaceGateReport(input({ proofs, campaign }));

    expect(report.proofInventory.find((item) => item.id === 'relay')).toMatchObject({
      status: 'stale',
      issues: [expect.stringContaining('later than gate report generatedAt')],
    });
    expect(report.overall.exitCode).toBe(1);
  });

  it('marks a retagged proof stale when its file mtime predates the campaign', () => {
    const proofs = allCampaignProofs();
    proofs.relay.proofFileMtimeMs = Date.parse('2026-07-20T23:59:59.999Z');

    const report = evaluateSurfaceGateReport(input({ proofs, campaign }));

    expect(report.proofInventory.find((item) => item.id === 'relay')).toMatchObject({
      status: 'stale',
      issues: [expect.stringContaining('proof file mtime predates')],
    });
    expect(report.overall.exitCode).toBe(1);
  });

  it('marks a retagged proof stale when a referenced artifact mtime predates the campaign', () => {
    const proofs = allCampaignProofs();
    proofs.managed.artifactFacts = {
      'campaign-artifact': [{
        exists: true,
        insideProofDirectory: true,
        mtimeMs: Date.parse('2026-07-20T23:59:59.999Z'),
      }],
    };

    const report = evaluateSurfaceGateReport(input({ proofs, campaign }));

    expect(report.proofInventory.find((item) => item.id === 'managed')).toMatchObject({
      status: 'stale',
      issues: [expect.stringContaining('artifact campaign-artifact[0] mtime predates')],
    });
    expect(report.overall.exitCode).toBe(1);
  });

  it('passes campaign freshness when every proof matches and has a current root timestamp', () => {
    const report = evaluateSurfaceGateReport(input({
      proofs: allCampaignProofs(),
      campaign,
    }));

    expect(report.campaign).toEqual(campaign);
    expect(report.proofInventory.every((item) => item.status === 'passed')).toBe(true);
    expect(report.overall).toMatchObject({ status: 'passed', exitCode: 0 });
  });

  it('marks a missing canonical proof and exits fail-closed', () => {
    const proofs = allProofs();
    delete (proofs as Partial<Record<SurfaceGateProofId, LoadedSurfaceProof>>).relay;
    const report = evaluateSurfaceGateReport(input({ proofs }));

    expect(report.proofInventory.find((item) => item.id === 'relay')).toMatchObject({
      status: 'missing',
      path: SURFACE_GATE_PROOF_PATHS.relay,
    });
    expect(report.overall).toMatchObject({ status: 'missing', exitCode: 1 });
  });

  it('reports a strict real Computer permission block as blocked_external and never passed', () => {
    const proofs = allProofs();
    proofs.computer = proof('computer', {
      status: 'blocked',
      stage: 'permissions',
      failure: {
        code: 'COMPUTER_PERMISSION_REQUIRED',
        userActionRequired: true,
        missing: ['screen_recording_capturable'],
      },
      assertions: { fixtureTerminated: true },
    });
    const report = evaluateSurfaceGateReport(input({ proofs }));

    expect(report.proofInventory.find((item) => item.id === 'computer')?.status)
      .toBe('blocked_external');
    expect(report.overall).toMatchObject({ status: 'blocked_external', exitCode: 1 });
  });

  it('allows only complete G3/G4 evidence-backed defers without weakening the exit gate', () => {
    const validDefer = {
      gate: 'G4' as const,
      reason: 'Requires a Windows host and platform helper signing.',
      evidenceObserved: ['current-host-is-darwin', 'windows-helper-is-not-present'],
      evidenceRequired: ['Windows real app E2E', 'signed helper identity'],
    };
    expect(validateEvidenceBackedDefer(validDefer)).toEqual([]);
    expect(validateEvidenceBackedDefer({
      gate: 'G2',
      reason: '',
      evidenceObserved: [],
      evidenceRequired: [],
    })).toEqual([
      'evidence-backed defer is only allowed for an explicit G3 or G4 item',
      'evidence-backed defer requires a reason',
      'evidence-backed defer requires non-empty evidenceObserved entries',
      'evidence-backed defer requires non-empty evidenceRequired entries',
    ]);

    const report = evaluateSurfaceGateReport(input({
      proofs: {
        ...allProofs(),
        durable: proof('durable', {
          assertions: { providerNeutralRegistryContractVerified: true },
        }),
      },
      t0: [],
      completionRows: [{
        phase: 'P2',
        id: 'p2-windows',
        title: 'Windows provider',
        bindings: [{
          proof: 'durable',
          assertions: ['providerNeutralRegistryContractVerified'],
        }],
        defer: validDefer,
      }],
    }));
    expect(report.completion.P2[0].status).toBe('evidence_backed_defer');
    expect(report.overall).toMatchObject({
      status: 'passed',
      exitCode: 0,
      hasEvidenceBackedDefers: true,
    });
  });

  it('rejects a defer-only completion row without a gate or proof binding', () => {
    const report = evaluateSurfaceGateReport(input({
      t0: [],
      completionRows: [{
        phase: 'P2',
        id: 'p2-defer-only',
        title: 'Unbound defer',
        defer: {
          gate: 'G4',
          reason: 'A future platform decision is still required.',
          evidenceObserved: ['self-reported-repository-observation'],
          evidenceRequired: ['real platform proof'],
        },
      }],
    }));

    expect(report.completion.P2[0]).toMatchObject({
      status: 'failed',
      issues: [expect.stringContaining('requires at least one gate or proof binding')],
    });
    expect(report.overall).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('retains implemented proof evidence on a partially deferred completion row and fails closed', () => {
    const proofs = allProofs();
    proofs.durable = proof('durable', {
      assertions: { internalAuthoritySeamVerified: true },
    });
    const completionRows = [{
      phase: 'P2' as const,
      id: 'p2-external-entrypoint',
      title: 'External entrypoint',
      bindings: [{ proof: 'durable' as const, assertions: ['internalAuthoritySeamVerified'] }],
      defer: {
        gate: 'G4' as const,
        reason: 'Public transport activation requires an approved authentication contract.',
        evidenceObserved: ['internal-authority-seam-verified', 'production-registration-absent'],
        evidenceRequired: ['approved-authentication-contract', 'real-entrypoint-e2e'],
      },
    }];
    const report = evaluateSurfaceGateReport(input({ proofs, t0: [], t1: [], completionRows }));
    expect(report.completion.P2[0]).toMatchObject({
      status: 'evidence_backed_defer',
      evidence: [{
        proof: 'durable',
        resolvedAssertionKeys: ['internalAuthoritySeamVerified'],
        status: 'passed',
      }],
    });

    const durableDocument = proofs.durable.document as Record<string, unknown>;
    (durableDocument.assertions as Record<string, boolean>).internalAuthoritySeamVerified = false;
    const failed = evaluateSurfaceGateReport(input({
      proofs,
      t0: [],
      t1: [],
      completionRows,
    }));
    expect(failed.completion.P2[0].status).toBe('failed');
    expect(failed.overall.exitCode).toBe(1);
  });

  it('accepts a G3 Relay capability defer only with a passing Managed fallback proof', () => {
    const proofs = allProofs();
    proofs.managed = proof('managed', {
      assertions: { managedClipboardBusinessReadbackVerified: true },
    });
    proofs.relay = proof('relay', {
      assertions: { relayClipboardFailClosed: true },
      evidenceBackedDefers: [{
        capability: 'relay_clipboard',
        status: 'evidence-backed-defer',
        gate: 'G3',
        reason: 'System clipboard permission boundary is unavailable in Relay.',
        fallback: 'managed',
        evidenceObserved: [
          'relay-request-failed-closed',
          'managed-fallback-readback-passed',
        ],
        evidenceRequired: ['Relay permission design', 'real clipboard cleanup E2E'],
      }],
    });
    const gate: SurfaceGateDefinition = {
      id: 'clipboard-defer',
      title: 'Clipboard fallback',
      bindings: [
        {
          proof: 'managed',
          assertions: ['clipboardBusinessStateVerified'],
          assertionAliases: {
            clipboardBusinessStateVerified: ['managedClipboardBusinessReadbackVerified'],
          },
        },
        { proof: 'relay', assertions: ['relayClipboardFailClosed'] },
      ],
      defer: {
        proof: 'relay',
        recordPaths: ['evidenceBackedDefers[]'],
        capability: 'relay_clipboard',
        fallback: 'managed',
        gate: 'G3',
      },
    };
    const report = evaluateSurfaceGateReport(input({
      proofs,
      t0: [],
      t1: [gate],
      completionRows: [{
        phase: 'P1',
        id: 'p1-clipboard',
        title: 'Clipboard',
        gateIds: ['clipboard-defer'],
      }],
    }));

    expect(report.t1[0]).toMatchObject({
      status: 'evidence_backed_defer',
      deferEvidence: {
        status: 'evidence_backed_defer',
        defer: { gate: 'G3', fallback: 'managed' },
      },
    });
    expect(report.t1[0].evidence[0].resolvedAssertionKeys)
      .toEqual(['managedClipboardBusinessReadbackVerified']);
    expect(report.completion.P1[0]).toMatchObject({
      status: 'evidence_backed_defer',
      gateDefers: [{
        gateId: 'clipboard-defer',
        gateTitle: 'Clipboard fallback',
        status: 'evidence_backed_defer',
        defer: {
          gate: 'G3',
          reason: 'System clipboard permission boundary is unavailable in Relay.',
          fallback: 'managed',
          capability: 'relay_clipboard',
          evidenceObserved: [
            'relay-request-failed-closed',
            'managed-fallback-readback-passed',
          ],
          evidenceRequired: ['Relay permission design', 'real clipboard cleanup E2E'],
        },
      }],
    });
    expect(report.overall).toMatchObject({ status: 'passed', exitCode: 0 });

    const relayDocument = proofs.relay.document as Record<string, unknown>;
    const defers = relayDocument.evidenceBackedDefers as Array<Record<string, unknown>>;
    delete defers[0].evidenceRequired;
    const malformed = evaluateSurfaceGateReport(input({
      proofs,
      t0: [],
      t1: [gate],
      completionRows: [],
    }));
    expect(malformed.t1[0].deferEvidence).toMatchObject({ status: 'failed' });
    expect(malformed.overall.exitCode).toBe(1);
  });

  it('gives an explicit canonical assertion precedence over a legacy alias', () => {
    const proofs = allProofs();
    proofs.managed = proof('managed', {
      assertions: {
        canonicalVerified: false,
        legacyVerified: true,
      },
    });
    const gate: SurfaceGateDefinition = {
      id: 'canonical-precedence',
      title: 'canonical precedence',
      bindings: [{
        proof: 'managed',
        assertions: ['canonicalVerified'],
        assertionAliases: {
          canonicalVerified: ['legacyVerified'],
        },
      }],
    };
    const failed = evaluateSurfaceGateReport(input({
      proofs,
      t0: [gate],
      completionRows: [],
    }));

    expect(failed.t0[0]).toMatchObject({
      status: 'failed',
      evidence: [{
        resolvedAssertionKeys: [],
        issues: [
          expect.stringContaining('canonical assertion canonicalVerified is false'),
        ],
      }],
    });
    expect(failed.overall.exitCode).toBe(1);

    const managedDocument = proofs.managed.document as Record<string, unknown>;
    const assertions = managedDocument.assertions as Record<string, unknown>;
    delete assertions.canonicalVerified;
    const compatible = evaluateSurfaceGateReport(input({
      proofs,
      t0: [gate],
      completionRows: [],
    }));
    expect(compatible.t0[0]).toMatchObject({
      status: 'passed',
      evidence: [{
        resolvedAssertionKeys: ['legacyVerified'],
      }],
    });
  });

  it('fails when artifact metadata does not match a real file fact', () => {
    const requirement: ArtifactRequirement = { recordPath: 'evidence.screenshot' };
    const proofs = allProofs();
    proofs.managed.artifactFacts = {
      [artifactRequirementKey(requirement)]: [{
        declaredPath: 'business.png',
        expectedSha256: 'd'.repeat(64),
        expectedBytes: 128,
        exists: true,
        insideProofDirectory: true,
        actualSha256: 'e'.repeat(64),
        actualBytes: 127,
      }],
    };
    const gate: SurfaceGateDefinition = {
      id: 'artifact-mismatch',
      title: 'artifact mismatch',
      bindings: [{ proof: 'managed', assertions: ['verified'], artifacts: [requirement] }],
    };
    const report = evaluateSurfaceGateReport(input({
      proofs,
      t0: [gate],
      completionRows: [{
        phase: 'P0',
        id: 'p0-artifact',
        title: 'P0 artifact',
        gateIds: ['artifact-mismatch'],
      }],
    }));

    expect(report.t0[0].status).toBe('failed');
    expect(report.t0[0].evidence[0].issues).toEqual(expect.arrayContaining([
      expect.stringContaining('byte count'),
      expect.stringContaining('sha256'),
    ]));
    expect(report.overall.exitCode).toBe(1);
  });

  it('rejects a proof-local symlink that points to an external artifact', () => {
    const content = 'external artifact must not be trusted';
    const fixture = artifactFixture('linked-artifact.txt', content);
    try {
      const externalPath = join(fixture.root, 'external-artifact.txt');
      writeFileSync(externalPath, content);
      symlinkSync(externalPath, join(fixture.proofDirectory, 'linked-artifact.txt'));

      const loaded = loadProof(fixture.root, 'managed', [fixture.requirement]);
      const [fact] = loaded.artifactFacts?.[artifactRequirementKey(fixture.requirement)] || [];

      expect(fact).toMatchObject({
        declaredPath: 'linked-artifact.txt',
        exists: false,
        insideProofDirectory: false,
        readError: expect.stringContaining('symbolic link'),
      });
      expect(fact.actualSha256).toBeUndefined();
      expect(fact.actualBytes).toBeUndefined();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a canonical proof directory symlink that points outside docs/acceptance', () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-gate-proof-link-'));
    try {
      const surfaceAcceptanceRoot = join(root, 'docs/acceptance/surface-execution');
      const externalProofDirectory = join(root, 'external-managed-proof');
      mkdirSync(surfaceAcceptanceRoot, { recursive: true });
      mkdirSync(externalProofDirectory, { recursive: true });
      writeFileSync(join(externalProofDirectory, 'proof.json'), JSON.stringify({
        status: 'passed',
        sourceFingerprint: fingerprint,
        assertions: { verified: true },
      }));
      symlinkSync(externalProofDirectory, join(surfaceAcceptanceRoot, 'managed-current'));

      const loaded = loadProof(root, 'managed', []);

      expect(loaded.document).toBeUndefined();
      expect(loaded.loadError).toContain('proof path contains a symbolic link');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a regular artifact in nested directories after realpath containment', () => {
    const content = 'nested canonical artifact';
    const declaredPath = 'nested/deeper/artifact.txt';
    const fixture = artifactFixture(declaredPath, content);
    try {
      const artifactPath = join(fixture.proofDirectory, declaredPath);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, content);

      const loaded = loadProof(fixture.root, 'managed', [fixture.requirement]);
      const [fact] = loaded.artifactFacts?.[artifactRequirementKey(fixture.requirement)] || [];

      expect(fact).toMatchObject({
        declaredPath,
        exists: true,
        insideProofDirectory: true,
        actualSha256: sha256(content),
        actualBytes: Buffer.byteLength(content),
      });
      expect(fact.readError).toBeUndefined();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('accepts a regular artifact directly in the canonical proof directory', () => {
    const content = 'normal canonical artifact';
    const declaredPath = 'artifact.txt';
    const fixture = artifactFixture(declaredPath, content);
    try {
      writeFileSync(join(fixture.proofDirectory, declaredPath), content);

      const loaded = loadProof(fixture.root, 'managed', [fixture.requirement]);
      const [fact] = loaded.artifactFacts?.[artifactRequirementKey(fixture.requirement)] || [];

      expect(fact).toMatchObject({
        declaredPath,
        exists: true,
        insideProofDirectory: true,
        actualSha256: sha256(content),
        actualBytes: Buffer.byteLength(content),
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('keeps the canonical corpus explicit: 8 proof paths and exactly 12 T0/12 T1 gates', () => {
    expect(Object.keys(SURFACE_GATE_PROOF_PATHS)).toHaveLength(8);
    expect(SURFACE_T0_GATES).toHaveLength(12);
    expect(SURFACE_T1_GATES).toHaveLength(12);
    for (const gate of [...SURFACE_T0_GATES, ...SURFACE_T1_GATES]) {
      expect(gate.bindings.length).toBeGreaterThan(0);
      for (const binding of gate.bindings) {
        expect(SURFACE_GATE_PROOF_PATHS[binding.proof]).toMatch(/proof\.json$/);
        expect(binding.assertions.length).toBeGreaterThan(0);
      }
    }
  });

  it('locks the exact P0/P1/P2 completion row IDs', () => {
    const ids = (phase: 'P0' | 'P1' | 'P2') => SURFACE_COMPLETION_ROWS
      .filter((row) => row.phase === phase)
      .map((row) => row.id);

    expect(ids('P0')).toEqual([
      'p0-a-contract-compatibility',
      'p0-b-runtime-control-plane',
      'p0-c-browser-trust-boundary',
      'p0-d-conversation-execution-ux',
      'p0-e-integrated-acceptance',
    ]);
    expect(ids('P1')).toEqual([
      'p1-browser-complex-targets-input',
      'p1-relay-artifact-parity',
      'p1-router-and-three-session-control',
      'p1-computer-and-cross-surface-recovery',
      'p1-pairing-doctor-protocol-upgrade',
      'p1-extension-store-signing',
      'p1-before-after-proof-and-durable-recovery',
    ]);
    expect(ids('P2')).toEqual([
      'p2-external-agent-adapters',
      'p2-organization-policy-audit-retention',
      'p2-replay-and-failure-reproduction',
      'p2-windows-linux-provider',
      'p2-provider-neutral-registry',
      'p2-continuous-real-site-app-regression',
      'p2-remote-pool-device-cloud',
    ]);
  });

  it('machine-binds P0-E to controlled authenticated-session evidence and explicitly defers external login sites', () => {
    const row = SURFACE_COMPLETION_ROWS.find((candidate) => (
      candidate.id === 'p0-e-integrated-acceptance'
    ));
    const managed = row?.bindings?.find((binding) => binding.proof === 'managed');
    const relay = row?.bindings?.find((binding) => binding.proof === 'relay');

    expect(managed).toMatchObject({
      assertions: ['managedAuthenticatedSessionVerified'],
      artifacts: [{ recordPath: 'complexEvidence.auth.screenshot' }],
      readbacks: ['complexEvidence.auth.businessReadback'],
    });
    expect(relay).toMatchObject({
      assertions: ['relayAuthenticatedSessionReused'],
      readbacks: ['authenticationEvidence.readback'],
    });
    expect(row?.defer).toMatchObject({
      gate: 'G3',
      evidenceObserved: expect.arrayContaining([
        'managed-proof:controlled-authenticated-session-isolated-profile-readback',
        'relay-proof:controlled-authenticated-session-reused-only-inside-explicit-tab-domain-action-time-scope',
      ]),
      evidenceRequired: expect.arrayContaining([
        'user-authorized-external-test-account-or-public-login-sandbox',
        'real-Managed-login-observe-act-verify-cleanup-E2E',
      ]),
    });
  });

  it('binds conversation completion to rendered frames, frozen capture context, outputs, terminal readback, and cross-surface reason', () => {
    const row = (id: string) => SURFACE_COMPLETION_ROWS.find((candidate) => candidate.id === id);
    expect(row('p0-d-conversation-execution-ux')?.bindings?.[0]).toMatchObject({
      proof: 'conversation',
      assertions: expect.arrayContaining([
        'conversation_evidence_frame_pixels',
        'evidence_frozen_capture_context',
        'owner_scoped_html_output_readback',
        'owner_scoped_png_output_pixels',
        'unknown_output_ref_fail_closed',
        'unified_run_status_running',
        'end_session_terminal_state',
        'unified_run_status_terminal',
        'terminal_frame_and_outputs_readback',
        'production_output_resolution_chain',
      ]),
    });
    expect(row('p1-computer-and-cross-surface-recovery')?.bindings).toContainEqual({
      proof: 'conversation',
      assertions: ['cross_surface_switch_reason_displayed'],
    });
  });

  it('classifies organization policy production enforcement and provider implementations as G4 defers', () => {
    const row = (id: string) => SURFACE_COMPLETION_ROWS.find((candidate) => candidate.id === id);
    const organization = row('p2-organization-policy-audit-retention');
    const providers = row('p2-provider-neutral-registry');

    expect(organization?.defer).toMatchObject({
      gate: 'G4',
      evidenceObserved: expect.arrayContaining([
        'repository:policy-enforcement-is-invoked-by-ExternalSurfaceAgentAdapter-and-acceptance-seam-only',
        'repository:Managed-Relay-Computer-production-policy-bootstrap-and-enforcement-absent',
      ]),
      evidenceRequired: expect.arrayContaining([
        'host-owned-organization-identity-and-policy-bootstrap-for-Managed-Relay-Computer',
        'real-Managed-Relay-Computer-provider-policy-enforcement-E2E',
      ]),
    });
    expect(providers).toMatchObject({
      bindings: [{
        proof: 'durable',
        assertions: [
          'providerNeutralRegistryContractVerified',
          'providerImplementationDefersExact',
        ],
        readbacks: ['p2Acceptance.evidenceBackedDefers.providerImplementations[]'],
      }],
      defer: { gate: 'G4' },
    });
  });

  it('fails closed unless the durable provider implementation defer set is exact and present', () => {
    const providerRow = SURFACE_COMPLETION_ROWS.find((candidate) => (
      candidate.id === 'p2-provider-neutral-registry'
    ));
    expect(providerRow).toBeDefined();
    const proofs = allProofs();
    proofs.durable = proof('durable', {
      assertions: {
        providerNeutralRegistryContractVerified: true,
        providerImplementationDefersExact: true,
      },
      p2Acceptance: {
        evidenceBackedDefers: {
          providerImplementations: [
            'multi-browser-provider',
            'remote-managed-browser-pool',
            'mobile-device-cloud',
            'windows-linux-profile-and-computer-provider',
            'in-app-preview-provider',
          ].map((row) => ({
            row,
            status: 'evidence-backed-defer',
            gate: 'G4',
            reason: 'Measured evidence is required before implementation.',
            evidenceObserved: ['truthful-observation'],
            evidenceRequired: ['real-provider-e2e'],
          })),
        },
      },
    });
    const passing = evaluateSurfaceGateReport(input({
      proofs,
      t0: [],
      t1: [],
      completionRows: [providerRow!],
    }));
    expect(passing.completion.P2[0]).toMatchObject({
      status: 'evidence_backed_defer',
      evidence: [{
        status: 'passed',
        readbackPaths: ['p2Acceptance.evidenceBackedDefers.providerImplementations[]'],
      }],
    });

    const durableAssertions = (
      proofs.durable.document as Record<string, unknown>
    ).assertions as Record<string, boolean>;
    durableAssertions.providerImplementationDefersExact = false;
    const inexact = evaluateSurfaceGateReport(input({
      proofs,
      t0: [],
      t1: [],
      completionRows: [providerRow!],
    }));
    expect(inexact.completion.P2[0]).toMatchObject({
      status: 'failed',
      evidence: [{
        status: 'failed',
        issues: [expect.stringContaining('providerImplementationDefersExact')],
      }],
    });

    durableAssertions.providerImplementationDefersExact = true;

    delete (proofs.durable.document as Record<string, unknown>).p2Acceptance;
    const missing = evaluateSurfaceGateReport(input({
      proofs,
      t0: [],
      t1: [],
      completionRows: [providerRow!],
    }));
    expect(missing.completion.P2[0]).toMatchObject({
      status: 'failed',
      evidence: [{
        status: 'missing',
        issues: [expect.stringContaining('providerImplementations[] is missing')],
      }],
    });
    expect(missing.overall.exitCode).toBe(1);
  });

  it('binds the continuous regression row to five representative proofs and explicit T2 thresholds', () => {
    const row = SURFACE_COMPLETION_ROWS.find((candidate) => (
      candidate.id === 'p2-continuous-real-site-app-regression'
    ));

    expect(row?.bindings?.map((binding) => binding.proof)).toEqual([
      'managed',
      'relay',
      'computer',
      'crossSurface',
      'workbuddy',
    ]);
    expect(row?.defer).toMatchObject({
      gate: 'G4',
      evidenceRequired: expect.arrayContaining([
        'T2-12-credentialed-real-site-and-real-app-task-corpus',
        'OTP-MFA-and-account-recovery-operator-protocol',
        'CI-Computer-host-with-real-accessibility-and-screen-recording-permissions',
        'real-task-success-rate-at-least-85-percent-or-15pp-over-baseline',
        'controlled-task-success-rate-at-least-95-percent',
        'recovery-success-rate-at-least-90-percent',
        'human-status-recognition-within-5-seconds-at-least-90-percent',
      ]),
    });
  });

  it('records partial P1/P2 capabilities as evidence-backed defers instead of verified implementations', () => {
    const row = (id: string) => SURFACE_COMPLETION_ROWS.find((candidate) => candidate.id === id);

    expect(row('p1-browser-complex-targets-input')?.defer).toMatchObject({ gate: 'G3' });
    expect(row('p1-pairing-doctor-protocol-upgrade')?.defer).toMatchObject({ gate: 'G3' });
    expect(row('p1-pairing-doctor-protocol-upgrade')?.bindings?.[0].assertions)
      .not.toContain('upgradeCompatibilityVerified');
    expect(row('p1-extension-store-signing')?.bindings?.[0].assertions)
      .not.toContain('upgradeCompatibilityVerified');
    expect(row('p2-replay-and-failure-reproduction')?.defer).toMatchObject({ gate: 'G4' });
    expect(row('p2-replay-and-failure-reproduction')?.bindings?.[1]).toMatchObject({
      proof: 'durable',
      assertions: expect.arrayContaining([
        'freshProcessReplayBoundary',
        'archiveProjectionReadOnly',
        'failureAdjustPassReproduced',
        'semanticDigestMatched',
        'portableScreenshotEvidenceMetadataOnly',
      ]),
    });
    expect(row('p1-before-after-proof-and-durable-recovery')?.bindings?.[2]).toMatchObject({
      proof: 'durable',
      assertions: expect.arrayContaining([
        'onlyExplicitContinueAvailable',
        'continuationOwnerScoped',
        'continuationSingleUse',
        'parentSessionLinked',
      ]),
    });
  });
});

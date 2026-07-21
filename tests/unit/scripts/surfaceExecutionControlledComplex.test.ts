import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_COMPLEX_ASSERTION_KEYS,
  CONTROLLED_COMPLEX_SCREENSHOT_TASKS,
  CONTROLLED_COMPLEX_TASKS,
  REQUIRED_BASE_MANAGED_ASSERTIONS,
  mergeControlledComplexIntoManagedProof,
  validateControlledComplexProof,
  type ControlledComplexProofV1,
} from '../../../scripts/acceptance/surface-execution-controlled-complex-core.ts';
import {
  SURFACE_COMPLETION_ROWS,
  SURFACE_GATE_PROOF_PATHS,
  SURFACE_T1_GATES,
  artifactRequirementKey,
  evaluateSurfaceGateReport,
  type ArtifactFact,
  type LoadedSurfaceProof,
  type SurfaceGateDefinition,
  type SurfaceGateProofId,
} from '../../../scripts/acceptance/surface-execution-gate-report-core.ts';
import type {
  SurfaceAcceptanceSourceFingerprintV1,
} from '../../../scripts/acceptance/surface-execution-proof.ts';

const fingerprint: SurfaceAcceptanceSourceFingerprintV1 = {
  version: 1,
  algorithm: 'sha256',
  sha256: 'a'.repeat(64),
  head: 'b'.repeat(40),
  dirty: true,
  dirtyPaths: ['scripts/acceptance/surface-execution-controlled-complex-smoke.ts'],
  scopes: ['src', 'scripts', 'tests'],
};

function controlledProof(): ControlledComplexProofV1 {
  const screenshotEvidence = Object.fromEntries(
    CONTROLLED_COMPLEX_SCREENSHOT_TASKS.map((task) => [task, {
      businessReadback: task + ' business state verified',
      screenshot: {
        path: task + '.png',
        sha256: 'c'.repeat(64),
        bytes: 128,
      },
    }]),
  );
  return {
    version: 1,
    status: 'passed',
    acceptance: 'surface-execution-controlled-complex',
    startedAt: '2026-07-21T00:00:00.000Z',
    finishedAt: '2026-07-21T00:01:00.000Z',
    worktree: '/tmp/worktree',
    head: fingerprint.head,
    originMain: 'd'.repeat(40),
    mergeBase: 'd'.repeat(40),
    sourceFingerprint: fingerprint,
    fixtureOrigin: 'http://127.0.0.1:43123',
    provider: 'system-chrome-cdp',
    browserVersion: 'Chrome/140.0.0.0',
    assertions: Object.fromEntries(
      CONTROLLED_COMPLEX_ASSERTION_KEYS.map((key) => [key, true]),
    ) as ControlledComplexProofV1['assertions'],
    complexEvidence: {
      ...screenshotEvidence,
      download: {
        businessReadback: 'download server payload hash and bytes verified',
        artifact: {
          path: 'controlled-download.txt',
          sha256: 'e'.repeat(64),
          bytes: 64,
        },
      },
    } as ControlledComplexProofV1['complexEvidence'],
    routerEvidence: {
      businessReadback: 'Production browser_action routing and business state verified',
      decisions: [
        {
          case: 'isolated_automation_routes_managed',
          requestedEngine: 'auto',
          selectedEngine: 'managed',
          reason: 'production_browser_action_dispatch_with_managed_intent',
          productionDispatch: true,
          capability: 'click',
          intent: 'isolated_automation',
          ownerAgentId: 'controlled-complex-agent',
          targetOwnerAgentId: 'controlled-complex-agent',
          provider: 'system-chrome-cdp',
          observationTraceId: 'trace-isolated-observe',
          mutationTraceId: 'trace-isolated-mutate',
          successorTraceId: 'trace-isolated-successor',
          successorVerified: true,
          businessReadback: 'Router isolated intent business state verified',
        },
        {
          case: 'login_reuse_without_lease_recovers_managed',
          requestedEngine: 'auto',
          selectedEngine: 'managed',
          reason: 'production_browser_action_dispatch_without_relay_lease',
          productionDispatch: true,
          capability: 'click',
          intent: 'login_reuse',
          ownerAgentId: 'controlled-complex-agent',
          targetOwnerAgentId: 'controlled-complex-agent',
          provider: 'system-chrome-cdp',
          observationTraceId: 'trace-login-observe',
          mutationTraceId: 'trace-login-mutate',
          successorTraceId: 'trace-login-successor',
          successorVerified: true,
          businessReadback: 'Router login reuse recovery business state verified',
        },
        {
          case: 'unsupported_relay_capability_recovers_managed',
          requestedEngine: 'auto',
          selectedEngine: 'managed',
          reason: 'production_browser_action_fill_form_dispatched_to_managed',
          productionDispatch: true,
          capability: 'fill_form',
          intent: 'login_reuse',
          ownerAgentId: 'controlled-complex-agent',
          targetOwnerAgentId: 'controlled-complex-agent',
          provider: 'system-chrome-cdp',
          observationTraceId: 'trace-capability-observe',
          mutationTraceId: 'trace-capability-mutate',
          successorTraceId: 'trace-capability-successor',
          successorVerified: true,
          businessReadback: 'Router capability fallback business state verified',
        },
        {
          case: 'wrong_owner_target_blocked_then_owner_recovers',
          requestedEngine: 'auto',
          selectedEngine: 'managed',
          reason: 'production_browser_action_owner_fence_then_owned_retry',
          recoveryCode: 'SURFACE_ELEMENT_REF_NOT_FOUND',
          productionDispatch: true,
          capability: 'click',
          intent: 'isolated_automation',
          ownerAgentId: 'controlled-router-attacker',
          targetOwnerAgentId: 'controlled-complex-agent',
          provider: 'system-chrome-cdp',
          observationTraceId: 'trace-owner-observe',
          mutationTraceId: 'trace-owner-mutate',
          successorTraceId: 'trace-owner-successor',
          successorVerified: true,
          businessReadback: 'Router owner recovery business state verified',
          blockedMutationTraceId: 'trace-owner-blocked',
          recoveryObservationTraceId: 'trace-owner-recovery-observe',
          blockedCode: 'SURFACE_ELEMENT_REF_NOT_FOUND',
          unchangedReadback: 'Router owner waiting',
        },
      ],
    },
    redactionCanary: {
      fingerprint: 'f'.repeat(64),
      rawAbsentFromResults: true,
      rawAbsentFromEvents: true,
      rawAbsentFromProof: true,
    },
    permissionRequests: [
      { tool: 'browser_action.write_clipboard', type: 'command', dangerLevel: 'warning' },
      { tool: 'browser_action.handle_dialog', type: 'dangerous_command', dangerLevel: 'danger' },
    ],
  };
}

function baseManagedProof(): Record<string, unknown> {
  return {
    version: 1,
    status: 'passed',
    recordedAt: '2026-07-21T00:00:00.000Z',
    sourceFingerprint: fingerprint,
    assertions: Object.fromEntries(
      REQUIRED_BASE_MANAGED_ASSERTIONS.map((key) => [key, true]),
    ),
  };
}

function loadedProof(
  id: SurfaceGateProofId,
  document: Record<string, unknown>,
): LoadedSurfaceProof {
  return {
    id,
    path: SURFACE_GATE_PROOF_PATHS[id],
    document,
  };
}

function allProofs(managed: Record<string, unknown>) {
  const proofs = Object.fromEntries(
    (Object.keys(SURFACE_GATE_PROOF_PATHS) as SurfaceGateProofId[]).map((id) => [
      id,
      loadedProof(id, {
        version: 1,
        status: 'passed',
        sourceFingerprint: fingerprint,
        assertions: id === 'relay' ? { agentWindowIsolation: true } : {},
      }),
    ]),
  ) as Record<SurfaceGateProofId, LoadedSurfaceProof>;
  proofs.managed = loadedProof('managed', managed);
  return proofs;
}

function managedArtifactFacts(
  gates: SurfaceGateDefinition[],
  proof: Record<string, unknown>,
): Record<string, ArtifactFact[]> {
  const facts: Record<string, ArtifactFact[]> = {};
  const complexEvidence = proof.complexEvidence as Record<
    string,
    { screenshot?: { path: string; sha256: string; bytes: number };
      artifact?: { path: string; sha256: string; bytes: number } }
  >;
  for (const gate of gates) {
    for (const binding of gate.bindings) {
      for (const requirement of binding.artifacts || []) {
        const task = requirement.recordPath.split('.')[1];
        const artifact = requirement.recordPath.endsWith('.artifact')
          ? complexEvidence[task].artifact
          : complexEvidence[task].screenshot;
        if (!artifact) throw new Error('Test fixture artifact missing for ' + requirement.recordPath);
        facts[artifactRequirementKey(requirement)] = [{
          declaredPath: artifact.path,
          resolvedPath: '/tmp/proof/' + artifact.path,
          expectedSha256: artifact.sha256,
          expectedBytes: artifact.bytes,
          exists: true,
          insideProofDirectory: true,
          actualSha256: artifact.sha256,
          actualBytes: artifact.bytes,
        }];
      }
    }
  }
  return facts;
}

describe('Surface controlled complex proof aggregation', () => {
  it('uses the production browser_action dispatch without a resolver-only or route-mock shortcut', () => {
    const source = readFileSync(resolve(
      'scripts/acceptance/surface-execution-controlled-complex-smoke.ts',
    ), 'utf8');
    expect(source).toContain('browserActionTool.execute(');
    expect(source).toContain("trace?.toolName === 'browser_action'");
    expect(source).not.toContain('resolveBrowserActionEngine');
    expect(source).not.toContain('.route(');
    expect(source).not.toContain('page.route');
  });

  it('validates and merges every complex assertion, including controlled HTTP auth', () => {
    const controlled = controlledProof();
    expect(validateControlledComplexProof(controlled, fingerprint)).toEqual([]);

    const merged = mergeControlledComplexIntoManagedProof({
      managedProof: baseManagedProof(),
      controlledProof: controlled,
      currentSourceFingerprint: fingerprint,
    });
    const assertions = merged.assertions as Record<string, unknown>;
    for (const key of [...REQUIRED_BASE_MANAGED_ASSERTIONS, ...CONTROLLED_COMPLEX_ASSERTION_KEYS]) {
      expect(assertions[key], key).toBe(true);
    }
    expect(assertions.managedAuthenticatedSessionVerified).toBe(true);
    expect(merged.complexEvidence).toMatchObject({
      auth: {
        businessReadback: 'auth business state verified',
        screenshot: { path: 'auth.png' },
      },
    });
  });

  it('fails closed for stale base proof, raw canary leakage, or incomplete evidence', () => {
    const controlled = controlledProof();
    const staleBase = baseManagedProof();
    staleBase.sourceFingerprint = { ...fingerprint, sha256: '0'.repeat(64) };
    expect(() => mergeControlledComplexIntoManagedProof({
      managedProof: staleBase,
      controlledProof: controlled,
      currentSourceFingerprint: fingerprint,
    })).toThrow('Managed base proof sourceFingerprint is stale');

    const leaked = structuredClone(controlled);
    leaked.complexEvidence.auth.businessReadback = 'RAW_CONTROLLED_CANARY';
    expect(validateControlledComplexProof(
      leaked,
      fingerprint,
      'RAW_CONTROLLED_CANARY',
    )).toContain('raw controlled complex canary leaked into proof');

    const incomplete = structuredClone(controlled);
    delete incomplete.complexEvidence.shadowDom.screenshot;
    incomplete.complexEvidence.iframe.businessReadback = '';
    expect(validateControlledComplexProof(incomplete, fingerprint)).toEqual(expect.arrayContaining([
      'complexEvidence.shadowDom.screenshot is missing',
      'complexEvidence.iframe.businessReadback is missing',
    ]));

    const resolverOnly = structuredClone(controlled);
    resolverOnly.routerEvidence.decisions[0].productionDispatch = false as true;
    resolverOnly.routerEvidence.decisions[0].observationTraceId = '';
    resolverOnly.routerEvidence.decisions[1].mutationTraceId =
      resolverOnly.routerEvidence.decisions[1].observationTraceId;
    resolverOnly.routerEvidence.decisions[3].blockedMutationTraceId = undefined;
    expect(validateControlledComplexProof(resolverOnly, fingerprint)).toEqual(expect.arrayContaining([
      'routerEvidence.isolated_automation_routes_managed must use production browser_action auto dispatch to System Chrome',
      'routerEvidence.isolated_automation_routes_managed requires observe, mutation, successor, owner, intent, and business readback evidence',
      'routerEvidence production dispatch phases must use distinct trace ids',
      'routerEvidence owner case must prove blocked cross-Agent mutation, unchanged state, and owned recovery',
    ]));
  });

  it('matches the exact Managed T1 gate schema and P1 router completion binding', () => {
    const controlled = controlledProof();
    const merged = mergeControlledComplexIntoManagedProof({
      managedProof: baseManagedProof(),
      controlledProof: controlled,
      currentSourceFingerprint: fingerprint,
    });
    const managedT1 = SURFACE_T1_GATES.flatMap((gate) => {
      const bindings = gate.bindings.filter((binding) => binding.proof === 'managed');
      return bindings.length > 0 ? [{ ...gate, bindings, defer: undefined }] : [];
    });
    expect(managedT1.map((gate) => gate.id)).toEqual([
      't1-01-react-reorder',
      't1-02-iframe',
      't1-03-oopif',
      't1-04-shadow-dom',
      't1-07-clipboard-policy',
      't1-10-download',
    ]);
    const routerRow = SURFACE_COMPLETION_ROWS.find((row) => (
      row.id === 'p1-router-and-three-session-control'
    ));
    expect(routerRow).toBeDefined();
    const proofs = allProofs(merged);
    proofs.managed.artifactFacts = managedArtifactFacts(managedT1, merged);
    const report = evaluateSurfaceGateReport({
      generatedAt: '2026-07-21T00:02:00.000Z',
      truthSource: 'docs/plans/2026-07-20-surface-execution-browser-computer-use.md',
      invocation: ['npx', 'tsx', 'surface-execution-gate-report.ts'],
      currentSourceFingerprint: fingerprint,
      git: {
        worktree: '/tmp/worktree',
        head: fingerprint.head,
        originMain: 'd'.repeat(40),
        mergeBase: 'd'.repeat(40),
        commands: [],
      },
      proofs,
      t0: [],
      t1: managedT1,
      completionRows: routerRow ? [routerRow] : [],
    });

    expect(report.t1.map((gate) => [gate.id, gate.status])).toEqual(
      managedT1.map((gate) => [gate.id, 'passed']),
    );
    expect(report.completion.P1).toEqual([
      expect.objectContaining({
        id: 'p1-router-and-three-session-control',
        status: 'passed',
      }),
    ]);
    expect(report.overall).toMatchObject({ status: 'passed', exitCode: 0 });
  });

  it('requires one artifact-bearing record for every controlled task', () => {
    const proof = controlledProof();
    expect(Object.keys(proof.complexEvidence).sort())
      .toEqual([...CONTROLLED_COMPLEX_TASKS].sort());
    for (const task of CONTROLLED_COMPLEX_TASKS) {
      const evidence = proof.complexEvidence[task];
      expect(evidence.businessReadback, task).not.toBe('');
      expect(task === 'download' ? evidence.artifact : evidence.screenshot, task)
        .toBeDefined();
    }
  });
});

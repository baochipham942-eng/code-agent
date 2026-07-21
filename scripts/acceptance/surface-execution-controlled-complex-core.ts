import type { SurfaceAcceptanceSourceFingerprintV1 } from './surface-execution-proof.ts';

export const CONTROLLED_COMPLEX_SCREENSHOT_TASKS = [
  'reactReorder',
  'iframe',
  'oopif',
  'shadowDom',
  'hover',
  'drag',
  'clipboard',
  'dialog',
  'auth',
] as const;

export const CONTROLLED_COMPLEX_TASKS = [
  ...CONTROLLED_COMPLEX_SCREENSHOT_TASKS,
  'download',
] as const;

export const CONTROLLED_COMPLEX_ASSERTION_KEYS = [
  'reactReorderFreshObservationVerified',
  'iframeExactTargetVerified',
  'oopifUnavailableFailClosed',
  'openShadowTargetVerified',
  'closedShadowFailClosed',
  'hoverBusinessStateVerified',
  'dragBusinessStateVerified',
  'clipboardBusinessStateVerified',
  'dialogPolicyBusinessStateVerified',
  'downloadArtifactAndBusinessStateVerified',
  'routerCapabilityOwnershipIntentVerified',
  'managedAuthenticatedSessionVerified',
] as const;

export const REQUIRED_BASE_MANAGED_ASSERTIONS = [
  'threeConcurrentSessions',
  'isolatedBrowserIdentities',
  'businessReadback',
  'crossAgentTargetBlocked',
  'independentPause',
  'pauseResume',
  'takeoverBlockedMutation',
  'takeoverResume',
  'noPostStopMutation',
  'redactionCanaryAbsent',
  'cleanupReleasedAllSessions',
] as const;

export type ControlledComplexTask = typeof CONTROLLED_COMPLEX_TASKS[number];
export type ControlledComplexAssertionKey = typeof CONTROLLED_COMPLEX_ASSERTION_KEYS[number];

export interface ControlledComplexArtifactV1 {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ControlledComplexEvidenceRecordV1 {
  businessReadback: string;
  screenshot?: ControlledComplexArtifactV1;
  artifact?: ControlledComplexArtifactV1;
  facts?: Record<string, unknown>;
}

export interface ControlledComplexRouterEvidenceV1 {
  businessReadback: string;
  decisions: Array<{
    case: string;
    requestedEngine: string;
    selectedEngine: string | null;
    reason: string;
    recoveryCode?: string | null;
    productionDispatch: true;
    capability: string;
    intent: string;
    ownerAgentId: string;
    targetOwnerAgentId: string;
    provider: string;
    observationTraceId: string;
    mutationTraceId: string;
    successorTraceId: string;
    successorVerified: true;
    businessReadback: string;
    blockedMutationTraceId?: string;
    recoveryObservationTraceId?: string;
    blockedCode?: string;
    unchangedReadback?: string;
  }>;
}

export interface ControlledComplexProofV1 {
  version: 1;
  status: 'passed';
  acceptance: 'surface-execution-controlled-complex';
  startedAt: string;
  finishedAt: string;
  worktree: string;
  head: string;
  originMain: string;
  mergeBase: string;
  sourceFingerprint: SurfaceAcceptanceSourceFingerprintV1;
  fixtureOrigin: string;
  provider: 'system-chrome-cdp';
  browserVersion: string;
  assertions: Record<ControlledComplexAssertionKey, true>;
  complexEvidence: Record<ControlledComplexTask, ControlledComplexEvidenceRecordV1>;
  routerEvidence: ControlledComplexRouterEvidenceV1;
  redactionCanary: {
    fingerprint: string;
    rawAbsentFromResults: true;
    rawAbsentFromEvents: true;
    rawAbsentFromProof: true;
  };
  permissionRequests: Array<{
    tool: string;
    type: string;
    dangerLevel?: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fingerprintRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function surfaceFingerprintEquals(
  left: unknown,
  right: SurfaceAcceptanceSourceFingerprintV1,
): boolean {
  const value = fingerprintRecord(left);
  if (!value) return false;
  return value.version === right.version
    && value.algorithm === right.algorithm
    && value.sha256 === right.sha256
    && value.head === right.head
    && value.dirty === right.dirty
    && JSON.stringify(value.dirtyPaths) === JSON.stringify(right.dirtyPaths)
    && JSON.stringify(value.scopes) === JSON.stringify(right.scopes);
}

function artifactIssues(
  record: ControlledComplexEvidenceRecordV1,
  task: ControlledComplexTask,
): string[] {
  const field = task === 'download' ? 'artifact' : 'screenshot';
  const artifact = record[field];
  if (!artifact) return [`complexEvidence.${task}.${field} is missing`];
  const issues: string[] = [];
  if (!artifact.path.trim()
    || artifact.path.includes('/')
    || artifact.path.includes('\\')
    || artifact.path === '.'
    || artifact.path === '..') {
    issues.push(`complexEvidence.${task}.${field}.path must be a proof-directory filename`);
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    issues.push(`complexEvidence.${task}.${field}.sha256 must be lowercase sha256`);
  }
  if (!Number.isInteger(artifact.bytes) || artifact.bytes <= 0) {
    issues.push(`complexEvidence.${task}.${field}.bytes must be a positive integer`);
  }
  return issues;
}

export function validateControlledComplexProof(
  proof: ControlledComplexProofV1,
  expectedFingerprint: SurfaceAcceptanceSourceFingerprintV1,
  rawCanary?: string,
): string[] {
  const issues: string[] = [];
  if (proof.status !== 'passed') issues.push('controlled complex proof status must be passed');
  if (proof.acceptance !== 'surface-execution-controlled-complex') {
    issues.push('controlled complex proof acceptance id is invalid');
  }
  if (!surfaceFingerprintEquals(proof.sourceFingerprint, expectedFingerprint)) {
    issues.push('controlled complex sourceFingerprint does not exactly match current source');
  }
  if (proof.head !== expectedFingerprint.head) {
    issues.push('controlled complex HEAD does not match sourceFingerprint HEAD');
  }
  if (proof.provider !== 'system-chrome-cdp' || !proof.browserVersion.trim()) {
    issues.push('controlled complex proof requires a real System Chrome provider and version');
  }
  for (const key of CONTROLLED_COMPLEX_ASSERTION_KEYS) {
    if (proof.assertions[key] !== true) issues.push(`assertions.${key} must be true`);
  }
  for (const task of CONTROLLED_COMPLEX_TASKS) {
    const record = proof.complexEvidence[task];
    if (!record) {
      issues.push(`complexEvidence.${task} is missing`);
      continue;
    }
    if (!record.businessReadback.trim()) {
      issues.push(`complexEvidence.${task}.businessReadback is missing`);
    }
    issues.push(...artifactIssues(record, task));
  }
  const requiredRouterCases = new Set([
    'isolated_automation_routes_managed',
    'login_reuse_without_lease_recovers_managed',
    'unsupported_relay_capability_recovers_managed',
    'wrong_owner_target_blocked_then_owner_recovers',
  ]);
  if (!proof.routerEvidence.businessReadback.trim() || proof.routerEvidence.decisions.length < 4) {
    issues.push('routerEvidence requires an explicit readback and four capability/ownership/intent decisions');
  }
  const routerTraceIds: string[] = [];
  for (const decision of proof.routerEvidence.decisions) {
    requiredRouterCases.delete(decision.case);
    if (decision.productionDispatch !== true
      || decision.requestedEngine !== 'auto'
      || decision.selectedEngine !== 'managed'
      || decision.provider !== 'system-chrome-cdp') {
      issues.push(`routerEvidence.${decision.case} must use production browser_action auto dispatch to System Chrome`);
    }
    if (typeof decision.capability !== 'string' || !decision.capability.trim()
      || typeof decision.intent !== 'string' || !decision.intent.trim()
      || typeof decision.ownerAgentId !== 'string' || !decision.ownerAgentId.trim()
      || typeof decision.targetOwnerAgentId !== 'string' || !decision.targetOwnerAgentId.trim()
      || typeof decision.observationTraceId !== 'string' || !decision.observationTraceId.trim()
      || typeof decision.mutationTraceId !== 'string' || !decision.mutationTraceId.trim()
      || typeof decision.successorTraceId !== 'string' || !decision.successorTraceId.trim()
      || decision.successorVerified !== true
      || typeof decision.businessReadback !== 'string' || !decision.businessReadback.trim()
      || typeof decision.reason !== 'string' || !decision.reason.trim()) {
      issues.push(`routerEvidence.${decision.case} requires observe, mutation, successor, owner, intent, and business readback evidence`);
    }
    routerTraceIds.push(
      decision.observationTraceId,
      decision.mutationTraceId,
      decision.successorTraceId,
      ...(decision.blockedMutationTraceId ? [decision.blockedMutationTraceId] : []),
      ...(decision.recoveryObservationTraceId ? [decision.recoveryObservationTraceId] : []),
    );
  }
  const populatedRouterTraceIds = routerTraceIds.filter((traceId) => (
    typeof traceId === 'string' && traceId.trim().length > 0
  ));
  if (new Set(populatedRouterTraceIds).size !== populatedRouterTraceIds.length) {
    issues.push('routerEvidence production dispatch phases must use distinct trace ids');
  }
  if (requiredRouterCases.size > 0) {
    issues.push(`routerEvidence is missing production dispatch cases: ${Array.from(requiredRouterCases).join(', ')}`);
  }
  const capabilityDecision = proof.routerEvidence.decisions.find((decision) => (
    decision.case === 'unsupported_relay_capability_recovers_managed'
  ));
  if (capabilityDecision?.capability !== 'fill_form'
    || capabilityDecision.intent !== 'login_reuse') {
    issues.push('routerEvidence capability recovery must dispatch browser_action.fill_form with login reuse intent');
  }
  const ownerDecision = proof.routerEvidence.decisions.find((decision) => (
    decision.case === 'wrong_owner_target_blocked_then_owner_recovers'
  ));
  if (!ownerDecision
    || ownerDecision.ownerAgentId === ownerDecision.targetOwnerAgentId
    || !ownerDecision.blockedMutationTraceId?.trim()
    || !ownerDecision.recoveryObservationTraceId?.trim()
    || !['SURFACE_ELEMENT_REF_NOT_FOUND', 'SURFACE_TARGET_REVISION_CHANGED']
      .includes(ownerDecision.blockedCode || '')
    || !ownerDecision.unchangedReadback?.trim()) {
    issues.push('routerEvidence owner case must prove blocked cross-Agent mutation, unchanged state, and owned recovery');
  }
  if (!/^[a-f0-9]{64}$/.test(proof.redactionCanary.fingerprint)
    || proof.redactionCanary.rawAbsentFromResults !== true
    || proof.redactionCanary.rawAbsentFromEvents !== true
    || proof.redactionCanary.rawAbsentFromProof !== true) {
    issues.push('redaction canary proof is incomplete');
  }
  if (rawCanary && JSON.stringify(proof).includes(rawCanary)) {
    issues.push('raw controlled complex canary leaked into proof');
  }
  return issues;
}

export function mergeControlledComplexIntoManagedProof(args: {
  managedProof: unknown;
  controlledProof: ControlledComplexProofV1;
  currentSourceFingerprint: SurfaceAcceptanceSourceFingerprintV1;
  rawCanary?: string;
}): Record<string, unknown> {
  const base = fingerprintRecord(args.managedProof);
  if (!base) throw new Error('Managed proof root must be an object');
  if (base.status !== 'passed') throw new Error('Managed base proof must have status=passed');
  if (!surfaceFingerprintEquals(base.sourceFingerprint, args.currentSourceFingerprint)) {
    throw new Error('Managed base proof sourceFingerprint is stale');
  }
  const baseAssertions = fingerprintRecord(base.assertions);
  if (!baseAssertions) throw new Error('Managed base proof assertions are missing');
  for (const key of REQUIRED_BASE_MANAGED_ASSERTIONS) {
    if (baseAssertions[key] !== true) {
      throw new Error(`Managed base proof assertion ${key} must be true before aggregation`);
    }
  }
  const controlledIssues = validateControlledComplexProof(
    args.controlledProof,
    args.currentSourceFingerprint,
    args.rawCanary,
  );
  if (controlledIssues.length > 0) {
    throw new Error(`Controlled complex proof is invalid: ${controlledIssues.join('; ')}`);
  }

  const merged: Record<string, unknown> = {
    ...base,
    status: 'passed',
    recordedAt: args.controlledProof.finishedAt,
    sourceFingerprint: args.currentSourceFingerprint,
    assertions: {
      ...baseAssertions,
      ...args.controlledProof.assertions,
    },
    complexEvidence: args.controlledProof.complexEvidence,
    routerEvidence: args.controlledProof.routerEvidence,
    controlledComplex: {
      acceptance: args.controlledProof.acceptance,
      startedAt: args.controlledProof.startedAt,
      finishedAt: args.controlledProof.finishedAt,
      fixtureOrigin: args.controlledProof.fixtureOrigin,
      provider: args.controlledProof.provider,
      browserVersion: args.controlledProof.browserVersion,
      head: args.controlledProof.head,
      redactionCanary: args.controlledProof.redactionCanary,
      permissionRequests: args.controlledProof.permissionRequests,
    },
  };
  if (args.rawCanary && JSON.stringify(merged).includes(args.rawCanary)) {
    throw new Error('Raw controlled complex canary leaked into merged Managed proof');
  }
  return merged;
}

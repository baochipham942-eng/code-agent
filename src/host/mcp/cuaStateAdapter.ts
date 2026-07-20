import { createHash, randomUUID } from 'node:crypto';
import type {
  ComputerUseActionResultV1,
  ComputerUseElementViewV1,
  ComputerUseExpectationV1,
  ComputerUseMutationV1,
  ComputerUseRootRefV1,
  ComputerUseStateErrorKindV1,
  ComputerUseStateViewV1,
} from '../../shared/contract/desktop';
import { requireSharp } from '../runtime/sharpRuntime';

const STATE_TTL_MS = 120_000;
const MAX_STATES_PER_SESSION = 32;
const PATCH_RADIUS_PX = 16;
const PATCH_MAX_MEAN_DELTA = 0.08;

type JsonRecord = Record<string, unknown>;

export interface CuaDriverCallResult {
  success: boolean;
  output?: string;
  error?: string;
  structured?: JsonRecord;
  screenshot?: { data: string; mimeType: string };
  deliveryUnknown?: boolean;
}

export interface CuaDriverCallContext {
  sessionId: string;
  /** Surface Session owner. Required for owner-safe mutations. */
  surfaceSessionId?: string;
  /** Native Run owner. Missing values are normalized only for legacy callers. */
  runId?: string;
  /** Explicit Surface isolation owner. Legacy callers are read/compatibility only. */
  agentId?: string;
  toolCallId: string;
  abortSignal?: AbortSignal;
}

/** Internal seam: production uses MCP; tests use an in-memory adapter. */
export interface CuaDriverPort {
  call(
    toolName: string,
    args: Record<string, unknown>,
    context: CuaDriverCallContext,
  ): Promise<CuaDriverCallResult>;
  getGeneration(): string | undefined;
}

export type CuaStatefulComputerUseRequest =
  | { operation: 'list_roots'; onScreenOnly?: boolean }
  | {
      operation: 'observe';
      target: { pid: number; windowId: number };
      query?: string;
      includeScreenshot?: boolean;
      maxElements?: number;
      maxDepth?: number;
    }
  | {
      operation: 'act';
      stateId: string;
      mutation: ComputerUseMutationV1;
      expect?: ComputerUseExpectationV1;
    };

type CuaStatefulComputerUseResponse =
  | { version: 1; operation: 'list_roots'; roots: ComputerUseRootRefV1[] }
  | { version: 1; operation: 'observe'; state: ComputerUseStateViewV1 }
  | { version: 1; operation: 'act'; result: ComputerUseActionResultV1 };

export interface CuaStatefulExecutionResult {
  response: CuaStatefulComputerUseResponse;
  imageDataUrl?: string;
}

export interface CuaStateOwnershipMetadata {
  sessionId: string;
  surfaceSessionId: string;
  runId: string;
  agentId: string;
  stateId: string;
  providerGeneration: string;
  providerSnapshotId: string;
}

interface StoredElement {
  view: ComputerUseElementViewV1;
  providerToken: string;
  providerIndex: number;
}

interface StoredState {
  sessionId: string;
  surfaceSessionId: string;
  runId: string;
  agentId: string;
  view: ComputerUseStateViewV1;
  providerGeneration: string;
  providerSnapshotId: string;
  elements: Map<string, StoredElement>;
  screenshot?: { data: string; mimeType: string };
  consumed: boolean;
  invalidReason?: 'superseded' | 'provider_restarted';
}

class CuaStateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CuaStateInputError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseJsonObject(output: string | undefined): JsonRecord | undefined {
  if (!output) return undefined;
  try {
    const parsed: unknown = JSON.parse(output);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rootKey(root: Pick<ComputerUseRootRefV1, 'pid' | 'windowId'>): string {
  return `${root.pid}:${root.windowId}`;
}

function imageDataUrl(image: { data: string; mimeType: string } | undefined): string | undefined {
  if (!image) return undefined;
  return `data:${image.mimeType};base64,${image.data}`;
}

function stateError(
  predecessorStateId: string,
  kind: ComputerUseStateErrorKindV1,
  message: string,
  evidenceRef: string,
  successorState?: ComputerUseStateViewV1,
): ComputerUseActionResultV1 {
  return {
    version: 1,
    predecessorStateId,
    delivery: 'not_attempted',
    verification: 'inconclusive',
    overall: 'failed',
    evidenceRef,
    ...(successorState ? { successorState } : {}),
    error: { kind, message },
  };
}

function parseRoot(value: unknown): ComputerUseRootRefV1 | null {
  if (!isRecord(value)) return null;
  const pid = integer(value.pid);
  const windowId = integer(value.window_id ?? value.windowId);
  if (pid === undefined || windowId === undefined) return null;
  const rawBounds = isRecord(value.bounds) ? value.bounds : undefined;
  const x = finiteNumber(rawBounds?.x);
  const y = finiteNumber(rawBounds?.y);
  const width = finiteNumber(rawBounds?.width);
  const height = finiteNumber(rawBounds?.height);
  const bounds = x !== undefined && y !== undefined && width !== undefined && height !== undefined
    ? { x, y, width, height }
    : undefined;
  return {
    provider: 'cua-driver',
    pid,
    windowId,
    ...(typeof value.app_name === 'string' ? { appName: value.app_name } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(bounds ? { bounds } : {}),
    ...(typeof value.is_on_screen === 'boolean' ? { isOnScreen: value.is_on_screen } : {}),
    ...(typeof value.on_current_space === 'boolean'
      ? { onCurrentSpace: value.on_current_space }
      : {}),
  };
}

function expectationFieldsAreValid(expectation: ComputerUseExpectationV1): boolean {
  switch (expectation.kind) {
    case 'element_exists':
    case 'element_absent':
      return Boolean(nonEmptyString(expectation.elementRef));
    case 'element_value_equals':
      return Boolean(nonEmptyString(expectation.elementRef)) && typeof expectation.value === 'string';
    case 'text_present':
      return Boolean(nonEmptyString(expectation.text));
    case 'window_present':
      return true;
  }
}

const TOKEN_MUTATIONS = new Set([
  'click',
  'double_click',
  'right_click',
  'set_value',
  'type_text',
  'press_key',
  'scroll',
]);

const POINT_MUTATIONS = new Set([
  'click',
  'double_click',
  'right_click',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'drag',
]);

function isConnectionError(message: string): boolean {
  return /timed out|timeout|connection closed|not connected|session expired|-32001/i.test(message);
}

function isStaleTokenError(message: string): boolean {
  return /stale|snapshot.*supersed|element_token.*invalid/i.test(message);
}

function normalizedRunId(context: CuaDriverCallContext): string {
  return context.runId?.trim() || `legacy:${context.sessionId}`;
}

function normalizedAgentId(context: CuaDriverCallContext): string {
  return context.agentId?.trim() || 'main';
}

function normalizedSurfaceSessionId(context: CuaDriverCallContext): string {
  return context.surfaceSessionId?.trim()
    || `legacy-surface:${context.sessionId}:${normalizedRunId(context)}:${normalizedAgentId(context)}`;
}

function ownerKey(
  context: Pick<CuaDriverCallContext, 'sessionId' | 'surfaceSessionId' | 'runId' | 'agentId'>,
): string {
  return JSON.stringify([
    context.sessionId,
    context.surfaceSessionId?.trim()
      || `legacy-surface:${context.sessionId}:${context.runId?.trim() || `legacy:${context.sessionId}`}:${context.agentId?.trim() || 'main'}`,
    context.runId?.trim() || `legacy:${context.sessionId}`,
    context.agentId?.trim() || 'main',
  ]);
}

export class CuaStateAdapter {
  private readonly statesByOwner = new Map<string, Map<string, StoredState>>();
  private readonly rootsByOwner = new Map<string, Map<string, ComputerUseRootRefV1>>();
  private readonly startedOwners = new Set<string>();
  private readonly hostRevisions = new Map<string, number>();

  constructor(
    private readonly driver: CuaDriverPort,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
  ) {}

  async execute(
    request: CuaStatefulComputerUseRequest,
    context: CuaDriverCallContext,
  ): Promise<CuaStatefulExecutionResult> {
    this.pruneExpired(context);
    if (request.operation === 'list_roots') {
      const roots = await this.listRoots(request.onScreenOnly ?? false, context);
      return { response: { version: 1, operation: 'list_roots', roots } };
    }
    if (request.operation === 'observe') {
      const observed = await this.observeRoot(request, context);
      return {
        response: { version: 1, operation: 'observe', state: observed.state.view },
        imageDataUrl: imageDataUrl(observed.state.screenshot),
      };
    }
    return this.act(request, context);
  }

  async startSurfaceSession(context: CuaDriverCallContext): Promise<void> {
    if (!context.surfaceSessionId?.trim() || !context.runId?.trim() || !context.agentId?.trim()) {
      throw new CuaStateInputError('cua-driver Surface session requires explicit session, run, and agent owner');
    }
    const key = ownerKey(context);
    if (this.startedOwners.has(key)) return;
    const result = await this.driver.call('start_session', {}, context);
    if (!result.success) {
      throw new Error(result.error ?? result.output ?? 'cua-driver start_session failed');
    }
    this.startedOwners.add(key);
  }

  async endSurfaceSession(context: CuaDriverCallContext): Promise<void> {
    const key = ownerKey(context);
    if (!this.startedOwners.has(key)) {
      this.purgeOwner(context);
      return;
    }
    let failure: Error | undefined;
    try {
      const result = await this.driver.call('end_session', {}, context);
      if (!result.success) {
        failure = new Error(result.error ?? result.output ?? 'cua-driver end_session failed');
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.startedOwners.delete(key);
      this.purgeOwner(context);
    }
    if (failure) throw failure;
  }

  purgeOwner(context: CuaDriverCallContext): void {
    const key = ownerKey(context);
    this.statesByOwner.delete(key);
    this.rootsByOwner.delete(key);
  }

  getStateOwnership(
    stateId: string,
    context: CuaDriverCallContext,
  ): CuaStateOwnershipMetadata | null {
    const state = this.statesByOwner.get(ownerKey(context))?.get(stateId);
    if (!state) return null;
    return {
      sessionId: state.sessionId,
      surfaceSessionId: state.surfaceSessionId,
      runId: state.runId,
      agentId: state.agentId,
      stateId: state.view.stateId,
      providerGeneration: state.providerGeneration,
      providerSnapshotId: state.providerSnapshotId,
    };
  }

  private async listRoots(
    onScreenOnly: boolean,
    context: CuaDriverCallContext,
  ): Promise<ComputerUseRootRefV1[]> {
    const result = await this.driver.call('list_windows', { on_screen_only: onScreenOnly }, context);
    if (!result.success) {
      throw new Error(result.error ?? result.output ?? 'cua-driver list_windows failed');
    }
    const structured = result.structured ?? parseJsonObject(result.output);
    const windows = structured && Array.isArray(structured.windows) ? structured.windows : [];
    const roots = windows.map(parseRoot).filter((root): root is ComputerUseRootRefV1 => Boolean(root));
    const byRoot = new Map(roots.map((root) => [rootKey(root), root]));
    this.rootsByOwner.set(ownerKey(context), byRoot);
    return roots;
  }

  private async observeRoot(
    request: Extract<CuaStatefulComputerUseRequest, { operation: 'observe' }>,
    context: CuaDriverCallContext,
  ): Promise<{ state: StoredState }> {
    const { pid, windowId } = request.target;
    if (!Number.isInteger(pid) || !Number.isInteger(windowId)) {
      throw new CuaStateInputError('observe.target.pid and windowId must be integers');
    }
    const targetKey = rootKey({ pid, windowId });
    const root = await this.resolveRoot({ pid, windowId }, context);
    const generationBefore = this.driver.getGeneration();
    const revisionBefore = this.hostRevisions.get(targetKey) ?? 0;
    const result = await this.driver.call('get_window_state', {
      pid,
      window_id: windowId,
      include_screenshot: request.includeScreenshot !== false,
      ...(request.query ? { query: request.query } : {}),
      ...(request.maxElements ? { max_elements: request.maxElements } : {}),
      ...(request.maxDepth ? { max_depth: request.maxDepth } : {}),
    }, context);
    if (!result.success) {
      throw new Error(result.error ?? result.output ?? 'cua-driver get_window_state failed');
    }
    const structured = result.structured ?? parseJsonObject(result.output);
    if (!structured) throw new Error('cua-driver did not return structuredContent');
    const snapshotId = nonEmptyString(structured.snapshot_id);
    if (!snapshotId) throw new Error('cua-driver snapshot_id missing; version 0.8.1+ is required');
    const generationAfter = this.driver.getGeneration();
    if (!generationAfter) throw new Error('cua-driver connection generation unavailable');
    if (generationBefore && generationAfter !== generationBefore) {
      throw new Error('cua-driver generation changed during observation; observe again');
    }
    const revisionAfter = this.hostRevisions.get(targetKey) ?? 0;
    if (revisionAfter !== revisionBefore) {
      throw new Error('the target changed during observation; observe again');
    }

    const observedAtMs = this.now();
    const stateId = `cua_${this.createId()}`;
    const rawElements = Array.isArray(structured.elements) ? structured.elements : [];
    const indexToRef = new Map<number, string>();
    rawElements.forEach((raw, position) => {
      if (!isRecord(raw)) return;
      const providerIndex = integer(raw.element_index);
      if (providerIndex !== undefined) indexToRef.set(providerIndex, `e${position + 1}`);
    });

    const elements = new Map<string, StoredElement>();
    rawElements.forEach((raw, position) => {
      if (!isRecord(raw)) return;
      const providerToken = nonEmptyString(raw.element_token);
      const providerIndex = integer(raw.element_index);
      const role = nonEmptyString(raw.role);
      if (!providerToken || providerIndex === undefined || !role) return;
      const ref = `e${position + 1}`;
      const rawFrame = isRecord(raw.frame) ? raw.frame : undefined;
      const x = finiteNumber(rawFrame?.x);
      const y = finiteNumber(rawFrame?.y);
      const width = finiteNumber(rawFrame?.w ?? rawFrame?.width);
      const height = finiteNumber(rawFrame?.h ?? rawFrame?.height);
      const parentIndex = integer(raw.parent_index);
      const view: ComputerUseElementViewV1 = {
        ref,
        role,
        ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
        ...(typeof raw.value === 'string' ? { value: raw.value } : {}),
        ...(x !== undefined && y !== undefined && width !== undefined && height !== undefined
          ? { frame: { x, y, width, height } }
          : {}),
        ...(parentIndex !== undefined && indexToRef.has(parentIndex)
          ? { parentRef: indexToRef.get(parentIndex) }
          : {}),
        ...(integer(raw.depth) !== undefined ? { depth: integer(raw.depth) } : {}),
      };
      elements.set(ref, { view, providerToken, providerIndex });
    });

    const screenshotId = result.screenshot
      ? `shot_${createHash('sha256').update(result.screenshot.data).digest('hex').slice(0, 24)}`
      : undefined;
    const view: ComputerUseStateViewV1 = {
      version: 1,
      stateId,
      root,
      hostRevision: revisionAfter,
      observedAtMs,
      expiresAtMs: observedAtMs + STATE_TTL_MS,
      ...(screenshotId ? { screenshotId } : {}),
      ...(finiteNumber(structured.screenshot_width) !== undefined
        ? { screenshotWidth: finiteNumber(structured.screenshot_width) }
        : {}),
      ...(finiteNumber(structured.screenshot_height) !== undefined
        ? { screenshotHeight: finiteNumber(structured.screenshot_height) }
        : {}),
      ...(structured.degraded === true ? { degraded: true } : {}),
      ...(typeof structured.degraded_reason === 'string'
        ? { degradedReason: structured.degraded_reason }
        : {}),
      elements: Array.from(elements.values(), (element) => element.view),
    };
    const state: StoredState = {
      sessionId: context.sessionId,
      surfaceSessionId: normalizedSurfaceSessionId(context),
      runId: normalizedRunId(context),
      agentId: normalizedAgentId(context),
      view,
      providerGeneration: generationAfter,
      providerSnapshotId: snapshotId,
      elements,
      ...(result.screenshot ? { screenshot: result.screenshot } : {}),
      consumed: false,
    };
    this.supersedeRootStates(context, root, stateId);
    this.rememberState(state);
    return { state };
  }

  private async act(
    request: Extract<CuaStatefulComputerUseRequest, { operation: 'act' }>,
    context: CuaDriverCallContext,
  ): Promise<CuaStatefulExecutionResult> {
    const evidenceRef = `cua-evidence:${this.createId()}`;
    const state = this.statesByOwner.get(ownerKey(context))?.get(request.stateId);
    if (!state) {
      return this.actionResponse(stateError(
        request.stateId,
        'stale_state',
        'stateId is unknown or expired; observe again',
        evidenceRef,
      ));
    }
    const invalid = this.validateStateForAction(state);
    if (invalid) return this.actionResponse(stateError(request.stateId, invalid.kind, invalid.message, evidenceRef));
    const targetInvalid = await this.validateCurrentRoot(state, context);
    if (targetInvalid) {
      return this.actionResponse(stateError(
        request.stateId,
        targetInvalid.kind,
        targetInvalid.message,
        evidenceRef,
      ));
    }
    if (request.expect && !expectationFieldsAreValid(request.expect)) {
      return this.actionResponse(stateError(
        request.stateId,
        'invalid_request',
        'expectation is missing the field required by its kind',
        evidenceRef,
      ));
    }
    if (
      request.expect
      && request.expect.kind.startsWith('element_')
      && !state.elements.has(request.expect.elementRef ?? '')
    ) {
      return this.actionResponse(stateError(
        request.stateId,
        'invalid_request',
        'expect.elementRef is not part of stateId',
        evidenceRef,
      ));
    }
    const preexisting = request.expect
      && request.expect.kind !== 'element_exists'
      && request.expect.kind !== 'window_present'
      ? this.evaluateExpectation(request.expect, state, state)
      : false;
    if (preexisting === true) {
      return this.actionResponse({
        version: 1,
        predecessorStateId: request.stateId,
        delivery: 'not_attempted',
        verification: 'preexisting',
        overall: 'succeeded',
        successorState: state.view,
        evidenceRef,
      }, state.screenshot);
    }

    let actionArgs: Record<string, unknown>;
    try {
      actionArgs = this.buildActionArgs(request.mutation, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.actionResponse(stateError(request.stateId, 'invalid_request', message, evidenceRef));
    }

    state.consumed = true;
    let coordinatePreflight: StoredState | undefined;
    if (request.mutation.point) {
      try {
        const observed = await this.observeRoot({
          operation: 'observe',
          target: { pid: state.view.root.pid, windowId: state.view.root.windowId },
          includeScreenshot: true,
        }, context);
        coordinatePreflight = observed.state;
        if (coordinatePreflight.providerGeneration !== state.providerGeneration) {
          state.invalidReason = 'provider_restarted';
          return this.actionResponse(stateError(
            request.stateId,
            'provider_restarted',
            'cua-driver restarted during coordinate preflight; observe again',
            evidenceRef,
            coordinatePreflight.view,
          ), coordinatePreflight.screenshot);
        }
        if (coordinatePreflight.view.hostRevision !== state.view.hostRevision) {
          return this.actionResponse(stateError(
            request.stateId,
            'state_conflict',
            'the target was changed by another Neo action during coordinate preflight',
            evidenceRef,
            coordinatePreflight.view,
          ), coordinatePreflight.screenshot);
        }
        const stable = await this.targetPatchIsStable(state, coordinatePreflight, request.mutation);
        if (!stable) {
          return this.actionResponse(stateError(
            request.stateId,
            'state_conflict',
            'the target window or screenshot region changed before coordinate delivery',
            evidenceRef,
            coordinatePreflight.view,
          ), coordinatePreflight.screenshot);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const providerRestarted = message.includes('generation changed');
        if (providerRestarted) state.invalidReason = 'provider_restarted';
        return this.actionResponse(stateError(
          request.stateId,
          providerRestarted ? 'provider_restarted' : 'state_conflict',
          `coordinate preflight failed: ${message}`,
          evidenceRef,
        ));
      }
    }

    const action = await this.driver.call(request.mutation.kind, actionArgs, context);
    const actionMessage = action.error ?? (!action.success ? action.output : undefined) ?? '';
    const deliveryUnknown = action.deliveryUnknown || isConnectionError(actionMessage);
    const delivery = action.success ? 'confirmed' : deliveryUnknown ? 'unknown' : 'rejected';

    let successor: StoredState | undefined;
    try {
      successor = (await this.observeRoot({
        operation: 'observe',
        target: { pid: state.view.root.pid, windowId: state.view.root.windowId },
        includeScreenshot: true,
      }, context)).state;
    } catch {
      successor = undefined;
    }

    const verification = !request.expect
      ? 'not_requested'
      : successor
        ? this.evaluateExpectation(request.expect, state, successor) === true
          ? 'satisfied'
          : 'unsatisfied'
        : 'inconclusive';
    const rejectedButSatisfied = delivery === 'rejected' && verification === 'satisfied';
    if (delivery === 'confirmed' || delivery === 'unknown' || rejectedButSatisfied) {
      const key = rootKey(state.view.root);
      const nextRevision = (this.hostRevisions.get(key) ?? 0) + 1;
      this.hostRevisions.set(key, nextRevision);
      if (successor) successor.view.hostRevision = nextRevision;
    }

    let overall: ComputerUseActionResultV1['overall'];
    if (delivery === 'unknown' || rejectedButSatisfied) overall = 'ambiguous';
    else if (delivery === 'rejected' || verification === 'unsatisfied') overall = 'failed';
    else if (verification === 'satisfied') overall = 'succeeded';
    else overall = 'delivered_unverified';

    let error: ComputerUseActionResultV1['error'];
    if (delivery === 'unknown') {
      error = { kind: 'delivery_unknown', message: actionMessage || 'delivery status is unknown' };
    } else if (isStaleTokenError(actionMessage)) {
      error = { kind: 'stale_state', message: actionMessage };
    } else if (delivery === 'rejected') {
      error = { kind: 'provider_error', message: actionMessage || 'cua-driver rejected the action' };
    } else if (verification === 'unsatisfied') {
      error = {
        kind: 'verification_failed',
        message: 'the successor state did not satisfy the expectation',
      };
    }
    const result: ComputerUseActionResultV1 = {
      version: 1,
      predecessorStateId: request.stateId,
      delivery,
      verification,
      overall,
      evidenceRef,
      ...(successor ? { successorState: successor.view } : {}),
      ...(error ? { error } : {}),
    };
    return this.actionResponse(result, successor?.screenshot);
  }

  private actionResponse(
    result: ComputerUseActionResultV1,
    screenshot?: { data: string; mimeType: string },
  ): CuaStatefulExecutionResult {
    return {
      response: { version: 1, operation: 'act', result },
      imageDataUrl: imageDataUrl(screenshot),
    };
  }

  private validateStateForAction(
    state: StoredState,
  ): { kind: ComputerUseStateErrorKindV1; message: string } | null {
    if (state.invalidReason === 'provider_restarted') {
      return { kind: 'provider_restarted', message: 'cua-driver restarted; observe again' };
    }
    if (state.invalidReason === 'superseded' || state.consumed || this.now() > state.view.expiresAtMs) {
      return { kind: 'stale_state', message: 'state was consumed, superseded, or expired; observe again' };
    }
    const generation = this.driver.getGeneration();
    if (!generation || generation !== state.providerGeneration) {
      state.invalidReason = 'provider_restarted';
      return { kind: 'provider_restarted', message: 'cua-driver generation changed; observe again' };
    }
    const revision = this.hostRevisions.get(rootKey(state.view.root)) ?? 0;
    if (revision !== state.view.hostRevision) {
      return { kind: 'state_conflict', message: 'the target was changed by another Neo action; observe again' };
    }
    return null;
  }

  private async validateCurrentRoot(
    state: StoredState,
    context: CuaDriverCallContext,
  ): Promise<{ kind: ComputerUseStateErrorKindV1; message: string } | null> {
    let roots: ComputerUseRootRefV1[];
    try {
      roots = await this.listRoots(false, context);
    } catch (error) {
      return {
        kind: 'provider_error',
        message: `window identity preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const current = roots.find((root) => rootKey(root) === rootKey(state.view.root));
    if (!current) {
      return { kind: 'target_missing', message: 'the observed app/window no longer exists' };
    }
    if (!current.appName?.trim() || current.appName !== state.view.root.appName) {
      return { kind: 'state_conflict', message: 'the window id now belongs to a different application' };
    }
    if (current.isOnScreen === false || current.onCurrentSpace === false) {
      return { kind: 'state_conflict', message: 'the observed window is no longer on the active visible surface' };
    }
    return null;
  }

  private buildActionArgs(
    mutation: ComputerUseMutationV1,
    state: StoredState,
  ): Record<string, unknown> {
    if (mutation.elementRef && mutation.point) {
      throw new CuaStateInputError('mutation must use either elementRef or point, not both');
    }
    if (mutation.kind === 'drag' && mutation.deliveryMode !== 'foreground') {
      throw new CuaStateInputError('drag requires deliveryMode=foreground on macOS');
    }
    const args: Record<string, unknown> = {
      pid: state.view.root.pid,
      window_id: state.view.root.windowId,
      ...(mutation.deliveryMode ? { delivery_mode: mutation.deliveryMode } : {}),
    };
    const element = mutation.elementRef ? state.elements.get(mutation.elementRef) : undefined;
    if (mutation.elementRef && !element) throw new CuaStateInputError('elementRef is not part of stateId');
    if (element) {
      if (!TOKEN_MUTATIONS.has(mutation.kind)) {
        throw new CuaStateInputError(`${mutation.kind} does not support elementRef`);
      }
      args.element_token = element.providerToken;
    } else if (mutation.point) {
      if (!POINT_MUTATIONS.has(mutation.kind)) {
        throw new CuaStateInputError(`${mutation.kind} does not support screenshot coordinates`);
      }
      if (!state.view.screenshotId || mutation.point.screenshotId !== state.view.screenshotId) {
        throw new CuaStateInputError('point.screenshotId does not match stateId');
      }
      const x = finiteNumber(mutation.point.x);
      const y = finiteNumber(mutation.point.y);
      if (x === undefined || y === undefined) {
        throw new CuaStateInputError('point.x and point.y must be finite numbers');
      }
      this.assertPointInScreenshot(state, x, y, 'point');
      args.x = x;
      args.y = y;
    } else if (!['hotkey', 'press_key'].includes(mutation.kind)) {
      throw new CuaStateInputError(`${mutation.kind} requires elementRef or point`);
    }

    switch (mutation.kind) {
      case 'set_value':
        if (typeof mutation.value !== 'string') throw new CuaStateInputError('set_value requires value');
        args.value = mutation.value;
        break;
      case 'type_text':
        if (typeof mutation.value !== 'string') throw new CuaStateInputError('type_text requires value');
        args.text = mutation.value;
        break;
      case 'press_key':
        if (!nonEmptyString(mutation.key)) throw new CuaStateInputError('press_key requires key');
        args.key = mutation.key;
        break;
      case 'hotkey':
        if (
          !Array.isArray(mutation.keys)
          || mutation.keys.length === 0
          || mutation.keys.some((key) => !nonEmptyString(key))
        ) {
          throw new CuaStateInputError('hotkey requires keys');
        }
        args.keys = mutation.keys;
        break;
      case 'scroll':
        if (!mutation.direction) throw new CuaStateInputError('scroll requires direction');
        args.direction = mutation.direction;
        if (mutation.amount !== undefined) args.amount = mutation.amount;
        break;
      case 'drag':
        if (!mutation.point || !mutation.toPoint) throw new CuaStateInputError('drag requires point and toPoint');
        if (mutation.toPoint.screenshotId !== state.view.screenshotId) {
          throw new CuaStateInputError('toPoint.screenshotId does not match stateId');
        }
        if (finiteNumber(mutation.toPoint.x) === undefined || finiteNumber(mutation.toPoint.y) === undefined) {
          throw new CuaStateInputError('toPoint.x and toPoint.y must be finite numbers');
        }
        this.assertPointInScreenshot(state, mutation.toPoint.x, mutation.toPoint.y, 'toPoint');
        delete args.x;
        delete args.y;
        args.from_x = mutation.point.x;
        args.from_y = mutation.point.y;
        args.to_x = mutation.toPoint.x;
        args.to_y = mutation.toPoint.y;
        break;
      default:
        break;
    }
    return args;
  }

  private assertPointInScreenshot(
    state: StoredState,
    x: number,
    y: number,
    field: 'point' | 'toPoint',
  ): void {
    const width = state.view.screenshotWidth;
    const height = state.view.screenshotHeight;
    if (!width || !height) {
      throw new CuaStateInputError(`${field} requires screenshot dimensions in stateId`);
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      throw new CuaStateInputError(`${field} is outside the stateId screenshot bounds`);
    }
  }

  private evaluateExpectation(
    expectation: ComputerUseExpectationV1,
    predecessor: StoredState,
    candidate: StoredState,
  ): boolean | null {
    switch (expectation.kind) {
      case 'window_present':
        return rootKey(predecessor.view.root) === rootKey(candidate.view.root);
      case 'text_present': {
        const text = expectation.text?.toLocaleLowerCase();
        if (!text) return null;
        return Array.from(candidate.elements.values()).some((element) =>
          [element.view.label, element.view.value]
            .filter((value): value is string => typeof value === 'string')
            .some((value) => value.toLocaleLowerCase().includes(text)));
      }
      case 'element_exists':
      case 'element_absent':
      case 'element_value_equals': {
        const ref = expectation.elementRef;
        if (!ref) return null;
        const source = predecessor.elements.get(ref);
        if (!source) return expectation.kind === 'element_absent';
        const matches = Array.from(candidate.elements.values()).filter((element) =>
          element.view.role === source.view.role
          && (source.view.label ? element.view.label === source.view.label : true));
        if (expectation.kind === 'element_exists') return matches.length > 0;
        if (expectation.kind === 'element_absent') return matches.length === 0;
        if (matches.length !== 1) return false;
        return matches[0]?.view.value === expectation.value;
      }
    }
  }

  private async targetPatchIsStable(
    before: StoredState,
    after: StoredState,
    mutation: ComputerUseMutationV1,
  ): Promise<boolean> {
    if (!mutation.point || !before.screenshot || !after.screenshot) return false;
    if (
      before.view.screenshotWidth !== after.view.screenshotWidth
      || before.view.screenshotHeight !== after.view.screenshotHeight
    ) return false;
    const width = before.view.screenshotWidth;
    const height = before.view.screenshotHeight;
    if (!width || !height) return false;
    if (before.view.screenshotId === after.view.screenshotId) return true;
    const points = [mutation.point, ...(mutation.toPoint ? [mutation.toPoint] : [])];
    for (const point of points) {
      if (!await this.patchIsStableAt(before, after, width, height, point.x, point.y)) {
        return false;
      }
    }
    return true;
  }

  private async resolveRoot(
    target: { pid: number; windowId: number },
    context: CuaDriverCallContext,
  ): Promise<ComputerUseRootRefV1> {
    const key = rootKey(target);
    let root = this.rootsByOwner.get(ownerKey(context))?.get(key);
    if (!root) {
      await this.listRoots(false, context);
      root = this.rootsByOwner.get(ownerKey(context))?.get(key);
    }
    if (!root?.appName?.trim()) {
      throw new CuaStateInputError('observe target is missing app identity; list roots and select a current window');
    }
    return root;
  }

  private async patchIsStableAt(
    before: StoredState,
    after: StoredState,
    width: number,
    height: number,
    x: number,
    y: number,
  ): Promise<boolean> {
    if (!before.screenshot || !after.screenshot) return false;
    const left = Math.max(0, Math.floor(x - PATCH_RADIUS_PX));
    const top = Math.max(0, Math.floor(y - PATCH_RADIUS_PX));
    const patchWidth = Math.min(PATCH_RADIUS_PX * 2, Math.floor(width - left));
    const patchHeight = Math.min(PATCH_RADIUS_PX * 2, Math.floor(height - top));
    if (patchWidth <= 0 || patchHeight <= 0) return false;
    try {
      const sharp = requireSharp({ allowBareModule: true });
      const extract = { left, top, width: patchWidth, height: patchHeight };
      const [a, b] = await Promise.all([
        sharp(Buffer.from(before.screenshot.data, 'base64')).extract(extract).removeAlpha().raw().toBuffer(),
        sharp(Buffer.from(after.screenshot.data, 'base64')).extract(extract).removeAlpha().raw().toBuffer(),
      ]);
      if (a.length !== b.length || a.length === 0) return false;
      let delta = 0;
      for (let index = 0; index < a.length; index += 1) {
        delta += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
      }
      return delta / (a.length * 255) <= PATCH_MAX_MEAN_DELTA;
    } catch {
      return false;
    }
  }

  private rememberState(state: StoredState): void {
    const key = ownerKey(state);
    let sessionStates = this.statesByOwner.get(key);
    if (!sessionStates) {
      sessionStates = new Map();
      this.statesByOwner.set(key, sessionStates);
    }
    sessionStates.set(state.view.stateId, state);
    while (sessionStates.size > MAX_STATES_PER_SESSION) {
      const oldest = sessionStates.keys().next().value as string | undefined;
      if (!oldest) break;
      sessionStates.delete(oldest);
    }
  }

  private supersedeRootStates(
    context: CuaDriverCallContext,
    root: ComputerUseRootRefV1,
    exceptStateId: string,
  ): void {
    const states = this.statesByOwner.get(ownerKey(context));
    if (!states) return;
    const key = rootKey(root);
    for (const state of states.values()) {
      if (state.view.stateId !== exceptStateId && rootKey(state.view.root) === key) {
        state.invalidReason = 'superseded';
      }
    }
  }

  private pruneExpired(context: CuaDriverCallContext): void {
    const key = ownerKey(context);
    const states = this.statesByOwner.get(key);
    if (!states) return;
    const now = this.now();
    for (const [stateId, state] of states) {
      if (now > state.view.expiresAtMs) states.delete(stateId);
    }
    if (states.size === 0) this.statesByOwner.delete(key);
  }
}

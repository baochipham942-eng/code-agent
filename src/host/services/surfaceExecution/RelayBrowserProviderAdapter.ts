import crypto from 'node:crypto';
import type { ToolExecutionResult } from '../../tools/types';
import type {
  SurfaceObservationV1,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import {
  browserRelayService,
  BrowserRelayProtocolError,
  type BrowserRelayCommandScopeV2,
  type BrowserRelayService,
} from '../infra/browserRelayService';
import type { BrowserTabLeaseV1 } from './BrowserTabLeaseService';
import {
  getSurfaceExecutionRuntime,
  type SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from './SurfaceExecutionRuntime';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';

const RELAY_PROVIDER = 'browser-relay';
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_ACTION_SCOPES = [
  'screenshot', 'get_content', 'get_dom_snapshot', 'get_a11y_snapshot',
  'click', 'click_text', 'type', 'press_key', 'scroll',
  'navigate', 'back', 'forward', 'reload', 'wait', 'get_logs', 'close',
];

interface RelaySafeTargetV2 {
  origin?: string;
  documentRevision?: string;
  title?: string;
}

interface RelayCommandResultV2 {
  output?: string;
  target?: RelaySafeTargetV2;
  imageBase64?: string;
  imageMimeType?: string;
  evidenceRefs?: string[];
  artifactRefs?: string[];
  elements?: Array<{
    ref?: string;
    backendNodeId?: number;
    frameRef?: string;
    role?: string;
    name?: string;
    bounds?: { x: number; y: number; width: number; height: number };
  }>;
  [key: string]: unknown;
}

interface RelayBinding {
  identity: SurfaceRuntimeIdentityV1;
  surfaceSessionId: string;
  hostLeaseId: string;
  extensionLeaseId: string;
  target: Extract<SurfaceTargetRefV1, { kind: 'browser' }>;
  providerGeneration: string;
  predecessorStateId: string;
  lease: BrowserTabLeaseV1;
}

export interface RelayBrowserActionInput {
  identity: SurfaceRuntimeIdentityV1;
  operationId: string;
  action: string;
  params: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function originFromUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function asCommandResult(value: unknown): RelayCommandResultV2 {
  return isRecord(value) ? value as RelayCommandResultV2 : {};
}

export class RelayBrowserProviderAdapter {
  private readonly bindings = new Map<string, RelayBinding>();

  constructor(
    private readonly relay: BrowserRelayService = browserRelayService,
    private readonly runtime: SurfaceExecutionRuntime = getSurfaceExecutionRuntime(),
  ) {
    this.relay.onDisconnect((extensionLeaseIds) => {
      for (const binding of this.bindings.values()) {
        if (!extensionLeaseIds.includes(binding.extensionLeaseId)) continue;
        try {
          this.runtime.browserTabLeases.markOrphaned({
            leaseId: binding.hostLeaseId,
            subject: this.leaseSubject(binding),
            code: 'provider_disconnected',
          });
        } catch {
          // The owning cleanup path remains authoritative and will fail closed.
        }
      }
    });
  }

  hasReadyLease(identity: SurfaceRuntimeIdentityV1): boolean {
    const binding = this.bindings.get(this.ownerKey(identity));
    if (!binding || !this.relay.hasActiveLease(binding.extensionLeaseId)) return false;
    try {
      return this.runtime.browserTabLeases.getOwned(
        binding.hostLeaseId,
        this.leaseSubject(binding),
      )?.state === 'leased';
    } catch {
      return false;
    }
  }

  getBinding(identity: SurfaceRuntimeIdentityV1): Readonly<RelayBinding> | null {
    const binding = this.bindings.get(this.ownerKey(identity));
    return binding ? structuredClone(binding) : null;
  }

  async requestLease(input: RelayBrowserActionInput): Promise<RelayBinding> {
    const existing = this.bindings.get(this.ownerKey(input.identity));
    if (existing && this.hasReadyLease(input.identity)) return existing;
    const prepared = this.runtime.prepareBrowserSession({
      identity: input.identity,
      provider: RELAY_PROVIDER,
    });
    const domainScopes = this.domainScopes(input.params);
    const actionScopes = this.actionScopes(input.params);
    const ttlMs = this.leaseTtl(input.params);
    const approval = await this.relay.requestTabLease({
      surfaceSessionId: prepared.session.sessionId,
      conversationId: input.identity.conversationId,
      runId: input.identity.runId,
      agentId: input.identity.agentId,
      requestId: `relay-lease-request-${crypto.randomUUID()}`,
      domainScopes,
      actionScopes,
      ttlMs,
    });
    const leaseSubject = {
      conversationId: input.identity.conversationId,
      sessionId: prepared.session.sessionId,
      runId: input.identity.runId,
      agentId: input.identity.agentId,
    };
    const available = this.runtime.browserTabLeases.registerAvailable({
      subject: leaseSubject,
      browserInstanceId: approval.placement.browserInstanceRef,
      tabRef: approval.placement.tabRef,
      agentWindowRef: approval.placement.agentWindowRef,
      originalPlacement: {
        windowRef: approval.placement.originalWindowRef,
        index: approval.placement.originalIndex,
        pinned: approval.placement.originalPinned,
      },
    });
    this.runtime.browserTabLeases.requestConsent({
      leaseId: available.leaseId,
      subject: leaseSubject,
      ttlMs: Math.max(1, approval.approvedAt - Date.now() + ttlMs),
    });
    const lease = this.runtime.browserTabLeases.approve({
      leaseId: available.leaseId,
      subject: leaseSubject,
      approvalRef: approval.approvalRef,
      domainScopes: approval.domainScopes,
      actionScopes: approval.actionScopes,
      ttlMs: Math.max(1, approval.expiresAt - Date.now()),
    });
    const target: Extract<SurfaceTargetRefV1, { kind: 'browser' }> = {
      kind: 'browser',
      browserInstanceId: approval.placement.browserInstanceRef,
      windowRef: approval.placement.agentWindowRef,
      tabRef: approval.placement.tabRef,
      origin: approval.placement.origin,
      documentRevision: approval.placement.documentRevision,
    };
    const generation = this.relay.getConnectionGeneration();
    if (!generation) {
      throw this.surfaceError(input, 'SURFACE_TRANSPORT_UNAVAILABLE', 'Relay connection generation is unavailable.');
    }
    const observed = this.runtime.recordBrowserObservation({
      identity: input.identity,
      surfaceSessionId: prepared.session.sessionId,
      provider: RELAY_PROVIDER,
      target,
      providerGeneration: generation,
      leaseId: lease.leaseId,
      leaseAction: approval.actionScopes[0],
      userSummary: 'The user approved a tab for this Relay Surface session',
    });
    const binding: RelayBinding = {
      identity: { ...input.identity },
      surfaceSessionId: prepared.session.sessionId,
      hostLeaseId: lease.leaseId,
      extensionLeaseId: approval.leaseId,
      target,
      providerGeneration: generation,
      predecessorStateId: observed.observation.stateId,
      lease,
    };
    this.bindings.set(this.ownerKey(input.identity), binding);
    this.runtime.registerBrowserTabLeaseCleanup({
      identity: input.identity,
      surfaceSessionId: binding.surfaceSessionId,
      leaseId: binding.hostLeaseId,
      restore: async () => {
        await this.relay.returnTabLease({
          ...this.commandScope(binding, `${input.operationId}:return`, 'lease:return', input.abortSignal),
        });
        this.bindings.delete(this.ownerKey(input.identity));
      },
    });
    return binding;
  }

  async execute(input: RelayBrowserActionInput): Promise<ToolExecutionResult> {
    try {
      if (input.action === 'launch') {
        const binding = await this.requestLease(input);
        return this.success('Relay tab lease approved.', binding, {
          target: binding.target,
          relayLease: binding.lease,
        });
      }
      const binding = this.requireBinding(input);
      if (input.action === 'close') {
        await this.runtime.control(this.subject(binding), 'end_session');
        return this.success('Relay Surface session ended and the borrowed tab was returned.', binding);
      }
      if (input.action === 'list_tabs') {
        return this.success('One explicitly leased Relay tab is available for this Surface session.', binding, {
          tabs: [{ tabRef: binding.target.tabRef, origin: binding.target.origin }],
        });
      }
      const descriptor = this.runtime.capabilities.resolve('browser_action', input.action, input.params);
      return descriptor.mutation
        ? await this.executeMutation(binding, input)
        : await this.executeObservation(binding, input);
    } catch (error) {
      return this.failure(error);
    }
  }

  private async executeObservation(
    binding: RelayBinding,
    input: RelayBrowserActionInput,
  ): Promise<ToolExecutionResult> {
    this.runtime.browserTabLeases.authorize({
      leaseId: binding.hostLeaseId,
      subject: this.leaseSubject(binding),
      target: binding.target,
      action: input.action,
    });
    const raw = await this.relay.executeLeasedCommand(
      this.commandScope(binding, input.operationId, input.action, input.abortSignal),
      this.methodFor(input.action),
      this.paramsFor(input.action, input.params),
    );
    const result = asCommandResult(raw);
    const recorded = this.recordSuccessor(binding, input, result);
    return this.success(result.output || `${input.action} completed on the leased tab.`, binding, {
      ...this.safeResultMetadata(result),
      surfaceExecutionSessionV1: recorded.session,
      surfaceObservationV1: recorded.observation,
      surfaceExecutionEventsV1: recorded.events,
    });
  }

  private async executeMutation(
    binding: RelayBinding,
    input: RelayBrowserActionInput,
  ): Promise<ToolExecutionResult> {
    const wrapped = await this.runtime.executeBrowserAction<RelayCommandResultV2>({
      identity: input.identity,
      surfaceSessionId: binding.surfaceSessionId,
      predecessorStateId: binding.predecessorStateId,
      provider: RELAY_PROVIDER,
      leaseId: binding.hostLeaseId,
      operationId: input.operationId,
      action: input.action,
      arguments: input.params,
      parentSignal: input.abortSignal,
      dispatch: async (signal) => {
        const raw = await this.relay.executeLeasedCommand(
          this.commandScope(binding, input.operationId, input.action, signal),
          this.methodFor(input.action),
          this.paramsFor(input.action, input.params),
        );
        const providerResult = asCommandResult(raw);
        const successor = this.recordSuccessor(binding, input, providerResult).observation;
        return {
          providerResult,
          outcome: {
            delivery: 'confirmed',
            verification: 'not_requested',
            overall: 'delivered_unverified',
            successorObservation: successor,
            evidenceRefs: stringArray(providerResult.evidenceRefs),
            artifactRefs: stringArray(providerResult.artifactRefs),
          },
        };
      },
    });
    return this.success(wrapped.providerResult.output || `${input.action} delivered to the leased tab.`, binding, {
      ...this.safeResultMetadata(wrapped.providerResult),
      surfaceExecutionSessionV1: wrapped.session,
      surfaceExecutionActionResultV1: wrapped.surfaceResult,
      surfaceExecutionEventsV1: wrapped.events,
    });
  }

  private recordSuccessor(
    binding: RelayBinding,
    input: RelayBrowserActionInput,
    result: RelayCommandResultV2,
  ) {
    const safeTarget = isRecord(result.target) ? result.target as RelaySafeTargetV2 : {};
    const target: Extract<SurfaceTargetRefV1, { kind: 'browser' }> = {
      ...binding.target,
      ...(typeof safeTarget.origin === 'string' ? { origin: safeTarget.origin } : {}),
      documentRevision: typeof safeTarget.documentRevision === 'string' && safeTarget.documentRevision
        ? safeTarget.documentRevision
        : `${binding.target.documentRevision}:${input.operationId}`,
      ...(typeof safeTarget.title === 'string' ? { title: safeTarget.title.slice(0, 200) } : {}),
    };
    const elements = Array.isArray(result.elements)
      ? result.elements.flatMap((element) => {
          if (!Number.isSafeInteger(element.backendNodeId) || typeof element.ref !== 'string') return [];
          return [{
            kind: 'browser-element' as const,
            ref: element.ref,
            tabRef: target.tabRef,
            ...(element.frameRef ? { frameRef: element.frameRef } : {}),
            documentRevision: target.documentRevision,
            backendNodeId: element.backendNodeId as number,
            ...(element.role ? { role: element.role } : {}),
            ...(element.name ? { name: element.name } : {}),
            ...(element.bounds ? { bounds: element.bounds } : {}),
          }];
        })
      : [];
    const recorded = this.runtime.recordBrowserObservation({
      identity: input.identity,
      surfaceSessionId: binding.surfaceSessionId,
      provider: RELAY_PROVIDER,
      target,
      providerGeneration: binding.providerGeneration,
      elements,
      evidenceAssetIds: stringArray(result.evidenceRefs),
      leaseId: binding.hostLeaseId,
      leaseAction: input.action,
      userSummary: `Observed the Relay tab after ${input.action}`,
    });
    binding.target = target;
    binding.predecessorStateId = recorded.observation.stateId;
    return recorded;
  }

  private commandScope(
    binding: RelayBinding,
    operationId: string,
    actionScope: string,
    abortSignal?: AbortSignal,
  ): BrowserRelayCommandScopeV2 {
    return {
      surfaceSessionId: binding.surfaceSessionId,
      conversationId: binding.identity.conversationId,
      runId: binding.identity.runId,
      agentId: binding.identity.agentId,
      leaseId: binding.extensionLeaseId,
      operationId,
      actionScope,
      ...(abortSignal ? { abortSignal } : {}),
    };
  }

  private requireBinding(input: RelayBrowserActionInput): RelayBinding {
    const binding = this.bindings.get(this.ownerKey(input.identity));
    if (!binding || !this.hasReadyLease(input.identity)) {
      throw this.surfaceError(input, 'BROWSER_TAB_BORROW_REQUIRED', 'A valid explicitly approved Relay tab lease is required.');
    }
    return binding;
  }

  private methodFor(action: string): string {
    const methods: Record<string, string> = {
      navigate: 'tab.navigate',
      back: 'tab.back',
      forward: 'tab.forward',
      reload: 'tab.reload',
      click: 'input.click',
      click_text: 'input.click_text',
      type: 'input.type',
      press_key: 'input.key',
      scroll: 'input.scroll',
      screenshot: 'tab.screenshot',
      get_content: 'page.content',
      get_dom_snapshot: 'dom.snapshot',
      get_a11y_snapshot: 'ax.snapshot',
      get_workbench_state: 'lease.get',
      get_account_state: 'lease.get',
      wait: 'operation.wait',
      get_logs: 'page.logs',
    };
    const method = methods[action];
    if (!method) throw new Error(`Relay action is not supported by protocol v2: ${action}`);
    return method;
  }

  private paramsFor(action: string, params: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {};
    if (action === 'navigate' && typeof params.url === 'string') safe.url = params.url;
    if ((action === 'click' || action === 'type') && typeof params.selector === 'string') safe.selector = params.selector;
    if (action === 'click_text' && typeof params.text === 'string') safe.text = params.text;
    if (action === 'type') {
      if (typeof params.text === 'string') safe.text = params.text;
      if (isRecord(params.targetRef)) safe.targetRef = params.targetRef;
    }
    if (action === 'click' && isRecord(params.targetRef)) safe.targetRef = params.targetRef;
    if (action === 'press_key' && typeof params.key === 'string') safe.key = params.key;
    if (action === 'scroll') {
      safe.direction = params.direction === 'up' ? 'up' : 'down';
      safe.amount = typeof params.amount === 'number' ? params.amount : 300;
    }
    if (action === 'screenshot') safe.fullPage = params.fullPage === true;
    if (action === 'wait') safe.timeoutMs = typeof params.timeout === 'number' ? params.timeout : 1_000;
    return safe;
  }

  private domainScopes(params: Record<string, unknown>): string[] {
    const requested = stringArray(params.relayDomainScopes);
    const urlOrigin = originFromUrl(params.url);
    return requested.length > 0 ? requested : urlOrigin ? [urlOrigin] : ['selected-tab-origin'];
  }

  private actionScopes(params: Record<string, unknown>): string[] {
    const requested = stringArray(params.relayActionScopes);
    return requested.length > 0 ? requested : [...DEFAULT_ACTION_SCOPES];
  }

  private leaseTtl(params: Record<string, unknown>): number {
    const requested = typeof params.relayLeaseTtlMs === 'number' ? params.relayLeaseTtlMs : DEFAULT_LEASE_TTL_MS;
    return Math.min(Math.max(Math.floor(requested), 1_000), 30 * 60_000);
  }

  private safeResultMetadata(result: RelayCommandResultV2): Record<string, unknown> {
    return {
      ...(typeof result.imageBase64 === 'string' ? { imageBase64: result.imageBase64 } : {}),
      ...(typeof result.imageMimeType === 'string' ? { imageMimeType: result.imageMimeType } : {}),
      ...(result.target ? { relayTarget: result.target } : {}),
      provider: RELAY_PROVIDER,
      engine: 'relay',
    };
  }

  private success(
    output: string,
    binding: RelayBinding,
    metadata: Record<string, unknown> = {},
  ): ToolExecutionResult {
    return {
      success: true,
      output,
      metadata: {
        provider: RELAY_PROVIDER,
        engine: 'relay',
        surfaceSessionId: binding.surfaceSessionId,
        relayLeaseId: binding.hostLeaseId,
        ...metadata,
      },
    };
  }

  private failure(error: unknown): ToolExecutionResult {
    if (error instanceof SurfaceExecutionRuntimeError) {
      return {
        success: false,
        error: error.message,
        metadata: { provider: RELAY_PROVIDER, engine: 'relay', surfaceExecutionErrorV1: error.surfaceError },
      };
    }
    if (error instanceof BrowserRelayProtocolError) {
      return {
        success: false,
        error: error.message,
        metadata: {
          provider: RELAY_PROVIDER,
          engine: 'relay',
          relayErrorV2: error.relayError,
          delivery: error.relayError.delivery,
        },
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: { provider: RELAY_PROVIDER, engine: 'relay' },
    };
  }

  private surfaceError(
    input: RelayBrowserActionInput,
    code: 'BROWSER_TAB_BORROW_REQUIRED' | 'SURFACE_TRANSPORT_UNAVAILABLE',
    message: string,
  ): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code,
      message,
      phase: 'prepare',
      retryable: true,
      userActionRequired: code === 'BROWSER_TAB_BORROW_REQUIRED',
      recommendedAction: code === 'BROWSER_TAB_BORROW_REQUIRED'
        ? 'Run browser_action launch with engine=relay, then approve the current tab in the extension popup.'
        : 'Reconnect the browser relay extension and request a new tab lease.',
      surface: 'browser',
      provider: RELAY_PROVIDER,
      sessionId: this.bindings.get(this.ownerKey(input.identity))?.surfaceSessionId || 'unbound',
      operationId: input.operationId,
    });
  }

  private subject(binding: RelayBinding) {
    return {
      sessionId: binding.surfaceSessionId,
      runId: binding.identity.runId,
      agentId: binding.identity.agentId,
    };
  }

  private leaseSubject(binding: RelayBinding) {
    return {
      conversationId: binding.identity.conversationId,
      sessionId: binding.surfaceSessionId,
      runId: binding.identity.runId,
      agentId: binding.identity.agentId,
    };
  }

  private ownerKey(identity: SurfaceRuntimeIdentityV1): string {
    return JSON.stringify([identity.conversationId, identity.runId, identity.agentId]);
  }
}

let relayBrowserProviderAdapter: RelayBrowserProviderAdapter | null = null;

export function getRelayBrowserProviderAdapter(): RelayBrowserProviderAdapter {
  relayBrowserProviderAdapter ??= new RelayBrowserProviderAdapter();
  return relayBrowserProviderAdapter;
}

export function resetRelayBrowserProviderAdapterForTests(): void {
  relayBrowserProviderAdapter = null;
}

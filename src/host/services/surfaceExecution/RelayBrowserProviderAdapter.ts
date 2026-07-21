import crypto from 'node:crypto';
import type { ToolExecutionResult } from '../../tools/types';
import type { SurfaceTargetRefV1 } from '../../../shared/contract/surfaceExecution';
import { redactSurfaceExecutionValue } from '../../../shared/utils/surfaceExecutionRedaction';
import {
  verifyBrowserUploadFile,
  type ApprovedBrowserUploadFile,
} from '../infra/browser/browserUploadApprovalRegistry';
import { inferMimeType } from '../infra/browser/managedBrowserHelpers';
import {
  BROWSER_RELAY_ACTION_METHODS_V2,
  type BrowserRelayActionScopeV2,
  type BrowserRelayLeaseApprovedV2,
  type BrowserRelayLeaseReturnResultV2,
  type BrowserRelayMethodV2,
} from '../../../shared/contract/browserRelay';
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
  'hover', 'drag', 'get_dialog_state',
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
  fileAssigned?: boolean;
  fileCount?: number;
  fileSize?: number;
  pending?: boolean;
  handled?: boolean;
  type?: 'alert' | 'beforeunload' | 'confirm' | 'prompt';
  messageLength?: number;
  openedAtMs?: number;
  defaultPolicy?: 'pause';
  action?: 'accept' | 'dismiss';
  browserArtifact?: Record<string, unknown>;
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
  entries?: Array<{
    cursor?: number;
    level?: string;
    source?: string;
    text?: string;
    url?: string;
    timestamp?: number;
    [key: string]: unknown;
  }>;
  nextCursor?: number;
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

export interface RelayBindingView {
  identity: Omit<SurfaceRuntimeIdentityV1, 'emitSurfaceEvent'>;
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

function approvedUploadFromParams(params: Record<string, unknown>): {
  approvalRef: string;
  file: ApprovedBrowserUploadFile;
} | null {
  if (!isRecord(params.approvedUpload)) return null;
  const value = params.approvedUpload;
  if (typeof value.approvalRef !== 'string'
    || typeof value.normalizedPath !== 'string'
    || typeof value.name !== 'string'
    || typeof value.sha256 !== 'string'
    || !Number.isSafeInteger(value.size)
    || !Number.isSafeInteger(value.device)
    || !Number.isSafeInteger(value.inode)
    || !Number.isFinite(value.modifiedAtMs)) return null;
  return {
    approvalRef: value.approvalRef,
    file: {
      normalizedPath: value.normalizedPath,
      name: value.name,
      size: Number(value.size),
      sha256: value.sha256,
      device: Number(value.device),
      inode: Number(value.inode),
      modifiedAtMs: Number(value.modifiedAtMs),
    },
  };
}

function asCommandResult(value: unknown): RelayCommandResultV2 {
  return isRecord(value) ? value as RelayCommandResultV2 : {};
}

function safeRelayLogUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? `${url.origin}${url.pathname}`.slice(0, 2_000)
      : '';
  } catch {
    return '';
  }
}

function safeRelayLogMetadata(result: RelayCommandResultV2): Record<string, unknown> | null {
  if (!Array.isArray(result.entries) && !Number.isSafeInteger(result.nextCursor)) return null;
  const entries = (result.entries || []).flatMap((entry) => {
    if (!Number.isSafeInteger(entry.cursor) || Number(entry.cursor) < 1) return [];
    const redacted = redactSurfaceExecutionValue(String(entry.text || '').slice(0, 10_000));
    return [{
      cursor: Number(entry.cursor),
      level: ['debug', 'error', 'info', 'log', 'trace', 'warn'].includes(String(entry.level))
        ? String(entry.level)
        : 'info',
      source: ['browser', 'console', 'network'].includes(String(entry.source))
        ? String(entry.source)
        : 'browser',
      text: typeof redacted === 'string' ? redacted : '[redacted]',
      url: safeRelayLogUrl(entry.url),
      timestamp: Number.isFinite(entry.timestamp) ? Number(entry.timestamp) : 0,
    }];
  }).slice(-200);
  const nextCursor = Number.isSafeInteger(result.nextCursor) && Number(result.nextCursor) >= 0
    ? Number(result.nextCursor)
    : entries.at(-1)?.cursor || 0;
  return { version: 1, entries, nextCursor };
}

function safeRelayDialogMetadata(result: RelayCommandResultV2): Record<string, unknown> | null {
  if (typeof result.pending !== 'boolean' && result.handled !== true) return null;
  const type = ['alert', 'beforeunload', 'confirm', 'prompt'].includes(String(result.type))
    ? result.type
    : undefined;
  return {
    pending: result.handled === true ? false : result.pending === true,
    ...(result.handled === true ? { handled: true } : {}),
    ...(type ? { type } : {}),
    ...(Number.isSafeInteger(result.messageLength) && Number(result.messageLength) >= 0
      ? { messageLength: Number(result.messageLength) }
      : {}),
    ...(Number.isFinite(result.openedAtMs) && Number(result.openedAtMs) > 0
      ? { openedAtMs: Number(result.openedAtMs) }
      : {}),
    defaultPolicy: 'pause',
    ...(result.action === 'accept' || result.action === 'dismiss'
      ? { action: result.action }
      : {}),
  };
}

export class RelayBrowserProviderAdapter {
  private readonly bindings = new Map<string, RelayBinding>();
  private readonly cleanupUnregisters = new Map<string, () => void>();
  private readonly lifecycleReconciliations = new Set<string>();

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
    this.relay.onLeaseLifecycle((result) => {
      if (result.type === 'lease.returned') void this.reconcileReturnedLease(result);
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

  getBinding(identity: SurfaceRuntimeIdentityV1): Readonly<RelayBindingView> | null {
    const binding = this.bindings.get(this.ownerKey(identity));
    if (!binding) return null;
    return structuredClone({
      ...binding,
      identity: {
        conversationId: binding.identity.conversationId,
        runId: binding.identity.runId,
        ...(typeof binding.identity.turnId === 'string'
          ? { turnId: binding.identity.turnId }
          : {}),
        agentId: binding.identity.agentId,
      },
    });
  }

  async requestLease(input: RelayBrowserActionInput): Promise<RelayBinding> {
    const existing = this.bindings.get(this.ownerKey(input.identity));
    if (existing) {
      if (this.hasReadyLease(input.identity)) return existing;
      throw this.surfaceError(
        input,
        'BROWSER_TAB_BORROW_REQUIRED',
        'The prior Relay tab must be returned or recovered before another tab can be borrowed.',
      );
    }
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
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    return await this.projectApprovedLease(input, prepared.session.sessionId, approval, ttlMs);
  }

  private async projectApprovedLease(
    input: RelayBrowserActionInput,
    surfaceSessionId: string,
    approval: BrowserRelayLeaseApprovedV2,
    ttlMs: number,
  ): Promise<RelayBinding> {
    const leaseSubject = {
      conversationId: input.identity.conversationId,
      sessionId: surfaceSessionId,
      runId: input.identity.runId,
      agentId: input.identity.agentId,
    };
    let hostLeaseId: string | null = null;
    let hostLeaseApproved = false;
    let unregisterCleanup: (() => void) | null = null;
    try {
      const generation = this.relay.getConnectionGeneration();
      if (!generation) {
        throw this.surfaceError(input, 'SURFACE_TRANSPORT_UNAVAILABLE', 'Relay connection generation is unavailable.');
      }
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
      hostLeaseId = available.leaseId;
      this.runtime.browserTabLeases.requestConsent({
        leaseId: available.leaseId,
        subject: leaseSubject,
        ttlMs: Math.min(60_000, Math.max(1, approval.approvedAt - Date.now() + ttlMs)),
      });
      const lease = this.runtime.browserTabLeases.approve({
        leaseId: available.leaseId,
        subject: leaseSubject,
        approvalRef: approval.approvalRef,
        domainScopes: this.hostDomainScopes(approval.domainScopes),
        actionScopes: approval.actionScopes,
        ttlMs: Math.max(1, approval.expiresAt - Date.now()),
      });
      hostLeaseApproved = true;
      const target: Extract<SurfaceTargetRefV1, { kind: 'browser' }> = {
        kind: 'browser',
        browserInstanceId: approval.placement.browserInstanceRef,
        windowRef: approval.placement.agentWindowRef,
        tabRef: approval.placement.tabRef,
        origin: approval.placement.origin,
        documentRevision: approval.placement.documentRevision,
      };
      const observed = this.runtime.recordBrowserObservation({
        identity: input.identity,
        surfaceSessionId,
        provider: RELAY_PROVIDER,
        target,
        providerGeneration: generation,
        leaseId: lease.leaseId,
        leaseAction: approval.actionScopes[0],
        userSummary: 'The user approved a tab for this Relay Surface session',
      });
      const binding: RelayBinding = {
        identity: { ...input.identity },
        surfaceSessionId,
        hostLeaseId: lease.leaseId,
        extensionLeaseId: approval.leaseId,
        target,
        providerGeneration: generation,
        predecessorStateId: observed.observation.stateId,
        lease,
      };
      this.bindings.set(this.ownerKey(input.identity), binding);
      unregisterCleanup = this.runtime.registerBrowserTabLeaseCleanup({
        identity: input.identity,
        surfaceSessionId: binding.surfaceSessionId,
        leaseId: binding.hostLeaseId,
        restore: async () => {
          await this.relay.returnTabLease({
            ...this.commandScope(binding, `${input.operationId}:return`, 'lease:return'),
          });
          const ownerKey = this.ownerKey(input.identity);
          this.cleanupUnregisters.get(ownerKey)?.();
          this.cleanupUnregisters.delete(ownerKey);
          this.bindings.delete(ownerKey);
        },
      });
      this.cleanupUnregisters.set(this.ownerKey(input.identity), unregisterCleanup);
      return binding;
    } catch (error) {
      unregisterCleanup?.();
      this.cleanupUnregisters.delete(this.ownerKey(input.identity));
      this.bindings.delete(this.ownerKey(input.identity));
      try {
        if (hostLeaseId && hostLeaseApproved) {
          await this.runtime.browserTabLeases.returnLease({
            leaseId: hostLeaseId,
            subject: leaseSubject,
            restore: () => this.returnApproval(input, surfaceSessionId, approval),
          });
        } else {
          await this.returnApproval(input, surfaceSessionId, approval);
          if (hostLeaseId) {
            this.runtime.browserTabLeases.cancelPending({ leaseId: hostLeaseId, subject: leaseSubject });
          }
        }
      } catch (rollbackError) {
        if (hostLeaseId && !hostLeaseApproved) {
          try {
            this.runtime.browserTabLeases.markOrphaned({
              leaseId: hostLeaseId,
              subject: leaseSubject,
              code: 'return_failed',
            });
            this.runtime.browserTabLeases.markRecoveryRequired({
              leaseId: hostLeaseId,
              subject: leaseSubject,
              code: 'return_failed',
            });
          } catch {
            // Preserve the original projection failure and report cleanup as authoritative.
          }
        }
        throw new SurfaceExecutionRuntimeError({
          code: 'SURFACE_CLEANUP_FAILED',
          message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          phase: 'cleanup',
          retryable: true,
          userActionRequired: true,
          recommendedAction: 'Keep the Relay tab open and retry recovery before starting another Surface session.',
          surface: 'browser',
          provider: RELAY_PROVIDER,
          sessionId: surfaceSessionId,
          operationId: input.operationId,
        });
      }
      throw error;
    }
  }

  private async returnApproval(
    input: RelayBrowserActionInput,
    surfaceSessionId: string,
    approval: BrowserRelayLeaseApprovedV2,
  ): Promise<void> {
    await this.relay.returnTabLease({
      surfaceSessionId,
      conversationId: input.identity.conversationId,
      runId: input.identity.runId,
      agentId: input.identity.agentId,
      leaseId: approval.leaseId,
      operationId: `${input.operationId}:rollback-return`,
      deadlineMs: 1_500,
    });
  }

  private async reconcileReturnedLease(result: BrowserRelayLeaseReturnResultV2): Promise<void> {
    const binding = Array.from(this.bindings.values()).find((candidate) => (
      candidate.extensionLeaseId === result.leaseId
      && candidate.surfaceSessionId === result.surfaceSessionId
      && candidate.identity.conversationId === result.conversationId
      && candidate.identity.runId === result.runId
      && candidate.identity.agentId === result.agentId
    ));
    if (!binding || this.lifecycleReconciliations.has(result.leaseId)) return;
    const ownerKey = this.ownerKey(binding.identity);
    this.lifecycleReconciliations.add(result.leaseId);
    try {
      await this.runtime.sessions.withCancellingOwnerCleanup(
        binding.surfaceSessionId,
        this.subject(binding),
        async () => {
          if (this.bindings.get(ownerKey) !== binding) return;
          const lease = this.runtime.browserTabLeases.getOwned(
            binding.hostLeaseId,
            this.leaseSubject(binding),
          );
          if (!lease || lease.state === 'returning' || lease.state === 'returned') return;
          this.runtime.browserTabLeases.confirmReturned({
            leaseId: binding.hostLeaseId,
            subject: this.leaseSubject(binding),
          });
          this.cleanupUnregisters.get(ownerKey)?.();
          this.cleanupUnregisters.delete(ownerKey);
          this.bindings.delete(ownerKey);
          this.runtime.grants.revokeForSession(this.subject(binding));
          await this.runtime.interrupts.endSession(this.subject(binding));
        },
      );
    } catch {
      // The exact-owner retry path remains available while the Host lease is retained.
    } finally {
      this.lifecycleReconciliations.delete(result.leaseId);
    }
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
        const approvedUpload = input.action === 'upload_file'
          ? approvedUploadFromParams(input.params)
          : null;
        if (input.action === 'upload_file' && !approvedUpload) {
          throw this.surfaceError(input, 'SURFACE_APPROVAL_INVALID', 'Relay upload has no exact Host-approved file identity.');
        }
        if (approvedUpload) {
          try {
            verifyBrowserUploadFile(approvedUpload.file);
          } catch {
            throw this.surfaceError(input, 'SURFACE_APPROVAL_INVALID', 'The exact approved upload file changed before Relay delivery.');
          }
        }
        const raw = await this.relay.executeLeasedCommand(
          this.commandScope(binding, input.operationId, input.action, signal),
          this.methodFor(input.action),
          this.paramsFor(input.action, input.params),
        );
        const providerResult = asCommandResult(raw);
        let uploadVerified: boolean | null = null;
        if (input.action === 'upload_file') {
          if (!approvedUpload) throw new Error('Relay upload approval invariant failed');
          let file: ApprovedBrowserUploadFile;
          try {
            file = verifyBrowserUploadFile(approvedUpload.file);
          } catch {
            throw new SurfaceExecutionRuntimeError({
              code: 'SURFACE_DELIVERY_UNKNOWN',
              message: 'The exact approved upload file changed while Chrome was assigning it.',
              phase: 'verify',
              retryable: true,
              userActionRequired: true,
              recommendedAction: 'Inspect the current file input, then request a new exact-file approval before retrying.',
              surface: 'browser',
              provider: RELAY_PROVIDER,
              sessionId: binding.surfaceSessionId,
              operationId: input.operationId,
            });
          }
          uploadVerified = providerResult.fileAssigned === true
            && providerResult.fileCount === 1
            && providerResult.fileSize === file.size;
          if (uploadVerified) {
            const artifactId = `upload_${Date.now()}_${file.sha256.slice(0, 12)}`;
            providerResult.browserArtifact = {
              artifactId,
              kind: 'upload',
              name: file.name,
              artifactPath: `.../${file.name}`,
              size: file.size,
              mimeType: inferMimeType(file.name),
              sha256: file.sha256,
              createdAtMs: Date.now(),
              sessionId: binding.surfaceSessionId,
            };
            providerResult.artifactRefs = [
              ...new Set([...stringArray(providerResult.artifactRefs), artifactId]),
            ];
            providerResult.output = `Upload file selected and verified: ${file.name} (${file.size} bytes, sha256=${file.sha256.slice(0, 12)})`;
          } else {
            providerResult.output = 'Chrome accepted the file-input command, but the selected file could not be verified.';
          }
        }
        const successor = this.recordSuccessor(binding, input, providerResult).observation;
        return {
          providerResult,
          outcome: {
            delivery: 'confirmed',
            verification: uploadVerified === null
              ? 'not_requested'
              : uploadVerified ? 'satisfied' : 'unsatisfied',
            overall: uploadVerified === null
              ? 'delivered_unverified'
              : uploadVerified ? 'succeeded' : 'failed',
            successorObservation: successor,
            evidenceRefs: stringArray(providerResult.evidenceRefs),
            artifactRefs: stringArray(providerResult.artifactRefs),
            ...(uploadVerified === false ? {
              error: {
                version: 1,
                code: 'SURFACE_POSTCONDITION_FAILED',
                message: 'The current file input did not report exactly one approved file with the expected byte size.',
                phase: 'verify',
                retryable: true,
                userActionRequired: false,
                recommendedAction: 'Capture a fresh file-input target and request a new exact-file approval before retrying.',
                surface: 'browser',
                provider: RELAY_PROVIDER,
                sessionId: binding.surfaceSessionId,
                operationId: input.operationId,
              },
            } : {}),
          },
        };
      },
    });
    const metadata = {
      ...this.safeResultMetadata(wrapped.providerResult),
      surfaceExecutionSessionV1: wrapped.session,
      surfaceExecutionActionResultV1: wrapped.surfaceResult,
      surfaceExecutionEventsV1: wrapped.events,
    };
    if (wrapped.surfaceResult.overall === 'failed') {
      return {
        success: false,
        error: wrapped.surfaceResult.error?.message || `${input.action} postcondition failed.`,
        metadata: {
          provider: RELAY_PROVIDER,
          engine: 'relay',
          surfaceSessionId: binding.surfaceSessionId,
          relayLeaseId: binding.hostLeaseId,
          ...metadata,
        },
      };
    }
    return this.success(wrapped.providerResult.output || `${input.action} delivered to the leased tab.`, binding, metadata);
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

  private methodFor(action: string): BrowserRelayMethodV2 {
    const method = BROWSER_RELAY_ACTION_METHODS_V2[action as BrowserRelayActionScopeV2];
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
    if ((action === 'click' || action === 'hover' || action === 'drag') && isRecord(params.targetRef)) {
      safe.targetRef = params.targetRef;
    }
    if (action === 'drag' && isRecord(params.destinationTargetRef)) {
      safe.destinationTargetRef = params.destinationTargetRef;
    }
    if (action === 'press_key' && typeof params.key === 'string') safe.key = params.key;
    if (action === 'scroll') {
      safe.direction = params.direction === 'up' ? 'up' : 'down';
      safe.amount = typeof params.amount === 'number' ? params.amount : 300;
    }
    if (action === 'screenshot') safe.fullPage = params.fullPage === true;
    if (action === 'wait') safe.timeoutMs = typeof params.timeout === 'number' ? params.timeout : 1_000;
    if (action === 'handle_dialog') {
      if (params.dialogAction === 'accept' || params.dialogAction === 'dismiss') {
        safe.dialogAction = params.dialogAction;
      }
      if (typeof params.dialogPromptText === 'string') safe.dialogPromptText = params.dialogPromptText;
    }
    if (action === 'upload_file') {
      const approvedUpload = approvedUploadFromParams(params);
      if (!approvedUpload) throw new Error('Relay upload requires an exact Host-approved file identity');
      safe.targetRef = params.targetRef;
      safe.uploadApprovalRef = approvedUpload.approvalRef;
      safe.uploadFilePath = approvedUpload.file.normalizedPath;
    }
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

  private hostDomainScopes(scopes: string[]): string[] {
    return scopes.map((scope) => {
      if (scope.startsWith('origin:')) return scope.slice('origin:'.length);
      if (scope.startsWith('host:')) return scope.slice('host:'.length);
      return scope;
    });
  }

  private leaseTtl(params: Record<string, unknown>): number {
    const requested = typeof params.relayLeaseTtlMs === 'number' ? params.relayLeaseTtlMs : DEFAULT_LEASE_TTL_MS;
    return Math.min(Math.max(Math.floor(requested), 1_000), 30 * 60_000);
  }

  private safeResultMetadata(result: RelayCommandResultV2): Record<string, unknown> {
    const logMetadata = safeRelayLogMetadata(result);
    const dialogMetadata = safeRelayDialogMetadata(result);
    return {
      ...(typeof result.imageBase64 === 'string' ? { imageBase64: result.imageBase64 } : {}),
      ...(typeof result.imageMimeType === 'string' ? { imageMimeType: result.imageMimeType } : {}),
      ...(result.target ? { relayTarget: result.target } : {}),
      ...(logMetadata ? { surfaceBrowserLogCursorV1: logMetadata } : {}),
      ...(dialogMetadata ? { browserDialogState: dialogMetadata } : {}),
      ...(typeof result.fileAssigned === 'boolean' ? {
        browserUploadVerification: {
          fileAssigned: result.fileAssigned,
          ...(Number.isSafeInteger(result.fileCount) ? { fileCount: result.fileCount } : {}),
          ...(Number.isSafeInteger(result.fileSize) ? { fileSize: result.fileSize } : {}),
        },
      } : {}),
      ...(result.browserArtifact ? { browserArtifact: result.browserArtifact } : {}),
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
    code: 'BROWSER_TAB_BORROW_REQUIRED' | 'SURFACE_TRANSPORT_UNAVAILABLE' | 'SURFACE_APPROVAL_INVALID',
    message: string,
  ): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code,
      message,
      phase: 'prepare',
      retryable: code !== 'SURFACE_APPROVAL_INVALID',
      userActionRequired: code === 'BROWSER_TAB_BORROW_REQUIRED' || code === 'SURFACE_APPROVAL_INVALID',
      recommendedAction: code === 'BROWSER_TAB_BORROW_REQUIRED'
        ? 'Run browser_action launch with engine=relay, then approve the current tab in the extension popup.'
        : code === 'SURFACE_APPROVAL_INVALID'
          ? 'Request a new one-time approval for the exact upload file.'
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

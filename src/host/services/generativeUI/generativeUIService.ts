// ============================================================================
// Generative UI Host service — admission, state events, and trusted manifests
// ============================================================================

import { createHash, randomUUID } from 'node:crypto';
import type { Message } from '../../../shared/contract/message';
import {
  NEO_UI_MAX_STATE_BYTES,
  NEO_UI_MAX_EVENT_BYTES,
  canonicalizeNeoUISpec,
  extractNeoUIRawSpecs,
  parseNeoUIModelSpec,
  type ExecutionManifestItemV1,
  type ExecutionManifestV1,
  type NeoUIEventResultV1,
  type NeoUIEventV1,
  type NeoUIHostSurfaceV1,
  type NeoUIInstanceV1,
  type NeoUIModelSpecV1,
  type NeoUIComponentNodeV1,
  type NeoUIResolveInstanceRequest,
  type NeoUIResolveInstanceResult,
  type NeoUIResolveManifestRequest,
  type NeoUIResolveManifestResult,
} from '../../../shared/contract/generativeUI';
import type { GenerativeUIRepository } from '../core/repositories/GenerativeUIRepository';
import { getFeatureFlagService } from '../cloud/featureFlagService';
import { recordGenerativeUIOutcome } from './generativeUITelemetry';
import { getGenerativeUIRepository } from './generativeUIRepositoryAccess';

const MANIFEST_TTL_MS = 10 * 60 * 1000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceKey(input: {
  sourceMessageId: string;
  sourceOrdinal: number;
  specHash: string;
}): string {
  return `${input.sourceMessageId}:${input.sourceOrdinal}:${input.specHash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findNode(spec: NeoUIModelSpecV1, nodeId: string): NeoUIComponentNodeV1 | null {
  const stack = [...spec.components];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    if (node.id === nodeId) return node;
    if (node.children) stack.push(...node.children);
  }
  return null;
}

function declaresIntent(node: NeoUIComponentNodeV1, intent: NeoUIEventV1['intent']): boolean {
  return intent !== 'approval.respond'
    && Boolean(node.actions?.some((action) => action.intent === intent));
}

function allowedStateRoots(node: NeoUIComponentNodeV1): Set<string> {
  const roots = new Set<string>([node.id]);
  for (const path of Object.values(node.bindings ?? {})) roots.add(path.split('.')[0]);
  for (const action of node.actions ?? []) {
    if (action.valuePath) roots.add(action.valuePath.split('.')[0]);
  }
  const parameters = Array.isArray(node.props?.parameters) ? node.props.parameters : [];
  for (const parameter of parameters) {
    if (isRecord(parameter) && typeof parameter.key === 'string') roots.add(parameter.key.split('.')[0]);
  }
  return roots;
}

function safeText(value: unknown, fallback: string, max = 240): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : fallback;
}

function createHostSurface(manifest: ExecutionManifestV1): NeoUIHostSurfaceV1 {
  return {
    schemaVersion: 1,
    surfaceId: `surface_${manifest.manifestId}`,
    origin: 'host',
    kind: 'execution_manifest',
    manifest,
  };
}

export interface GenerativeUIServiceOptions {
  repo?: GenerativeUIRepository;
  now?: () => number;
  enabled?: () => boolean;
  manifestEnabled?: () => boolean;
  resolveResourceRevision?: (item: ExecutionManifestItemV1) => string | undefined;
}

export class GenerativeUIService {
  private readonly repo: GenerativeUIRepository;
  private readonly now: () => number;
  private readonly enabled: () => boolean;
  private readonly manifestEnabled: () => boolean;
  private readonly resolveResourceRevision: (item: ExecutionManifestItemV1) => string | undefined;

  constructor(options: GenerativeUIServiceOptions = {}) {
    this.repo = options.repo ?? getGenerativeUIRepository();
    this.now = options.now ?? Date.now;
    this.enabled = options.enabled ?? (() => (
      process.env.CODE_AGENT_NATIVE_GENERATIVE_UI === '1'
      || getFeatureFlagService().isEnabled('nativeGenerativeUI')
    ));
    this.manifestEnabled = options.manifestEnabled ?? (() => (
      process.env.CODE_AGENT_EXECUTION_MANIFEST_V1 === '1'
      || getFeatureFlagService().isEnabled('executionManifestV1')
    ));
    this.resolveResourceRevision = options.resolveResourceRevision ?? ((item) => item.resourceRevision);
  }

  isEnabled(): boolean {
    return this.enabled();
  }

  isManifestEnabled(): boolean {
    return this.manifestEnabled();
  }

  admitMessage(sessionId: string, message: Pick<Message, 'id' | 'role' | 'content'>): NeoUIInstanceV1[] {
    if (!this.isEnabled() || message.role !== 'assistant') return [];
    const admitted: NeoUIInstanceV1[] = [];
    for (const { rawSpec, sourceOrdinal } of extractNeoUIRawSpecs(message.content)) {
      const result = this.admitSpec({
        sessionId,
        sourceMessageId: message.id,
        sourceOrdinal,
        rawSpec,
      }, false);
      if (result.instance) admitted.push(result.instance);
    }
    return admitted;
  }

  resolveInstance(request: NeoUIResolveInstanceRequest): NeoUIResolveInstanceResult {
    if (!this.isEnabled()) {
      const parsed = parseNeoUIModelSpec(request.rawSpec);
      return {
        enabled: false,
        ...(parsed.success ? { fallback: parsed.spec.fallback } : { error: parsed.error, fallback: parsed.fallback }),
      };
    }
    return this.admitSpec(request, true);
  }

  private admitSpec(request: NeoUIResolveInstanceRequest, requirePersistedMessage: boolean): NeoUIResolveInstanceResult {
    const parsed = parseNeoUIModelSpec(request.rawSpec);
    if (!parsed.success) {
      recordGenerativeUIOutcome({ phase: 'admission', outcome: 'fallback', reason: parsed.error });
      return { enabled: true, error: parsed.error, fallback: parsed.fallback };
    }
    const canonical = canonicalizeNeoUISpec(parsed.spec);
    const specHash = sha256(canonical);
    const key = sourceKey({ ...request, specHash });
    if (requirePersistedMessage) {
      const sourceContent = this.repo.getSourceMessageContent(request.sessionId, request.sourceMessageId);
      if (sourceContent === null) {
        recordGenerativeUIOutcome({ phase: 'admission', outcome: 'rejected', reason: 'SOURCE_MESSAGE_NOT_PERSISTED' });
        return { enabled: true, error: 'SOURCE_MESSAGE_NOT_PERSISTED', fallback: parsed.spec.fallback };
      }
      const sourceSpec = extractNeoUIRawSpecs(sourceContent)
        .find((candidate) => candidate.sourceOrdinal === request.sourceOrdinal);
      const sourceParsed = sourceSpec ? parseNeoUIModelSpec(sourceSpec.rawSpec) : null;
      const sourceHash = sourceParsed?.success
        ? sha256(canonicalizeNeoUISpec(sourceParsed.spec))
        : null;
      if (sourceHash !== specHash) {
        recordGenerativeUIOutcome({ phase: 'admission', outcome: 'rejected', reason: 'SOURCE_SPEC_MISMATCH' });
        return { enabled: true, error: 'SOURCE_SPEC_MISMATCH', fallback: parsed.spec.fallback };
      }
    }
    const existing = this.repo.getBySourceKey(key);
    if (existing) {
      recordGenerativeUIOutcome({
        phase: 'admission',
        outcome: 'replayed',
        schemaVersion: existing.schemaVersion,
        componentTypes: [...new Set(existing.spec.components.map((node) => node.type))].sort().join(','),
      });
      const storedManifest = this.repo.getLatestManifestForInstance(existing.instanceId);
      const manifest = storedManifest ? this.refreshManifestForSurface(storedManifest) : null;
      return {
        enabled: true,
        instance: existing,
        ...(manifest ? { hostSurface: createHostSurface(manifest) } : {}),
      };
    }
    const now = this.now();
    this.repo.invalidateSupersededInstances(
      request.sessionId,
      request.sourceMessageId,
      request.sourceOrdinal,
      specHash,
      now,
    );
    const instance: NeoUIInstanceV1 = {
      schemaVersion: 1,
      instanceId: `neoui_${randomUUID()}`,
      sessionId: request.sessionId,
      sourceMessageId: request.sourceMessageId,
      sourceOrdinal: request.sourceOrdinal,
      sourceKey: key,
      specHash,
      origin: 'model',
      spec: parsed.spec,
      state: structuredClone(parsed.spec.initialState ?? {}),
      stateRevision: 0,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const inserted = this.repo.insertInstance({ instance });
    recordGenerativeUIOutcome({
      phase: 'admission',
      outcome: 'admitted',
      schemaVersion: inserted.schemaVersion,
      componentTypes: [...new Set(inserted.spec.components.map((node) => node.type))].sort().join(','),
    });
    return { enabled: true, instance: inserted };
  }

  applyEvent(event: NeoUIEventV1): NeoUIEventResultV1 {
    const finish = (result: NeoUIEventResultV1): NeoUIEventResultV1 => {
      recordGenerativeUIOutcome({
        phase: 'event',
        outcome: result.status,
        intent: event.intent,
        ...(result.error ? { reason: result.error } : {}),
      });
      return result;
    };
    if (!this.isEnabled()) return finish({ status: 'rejected', error: 'FEATURE_DISABLED' });
    if (event.intent === 'approval.respond') {
      return finish({ status: 'rejected', error: 'HOST_SURFACE_REQUIRED' });
    }
    if (new TextEncoder().encode(JSON.stringify(event.payload ?? {})).length > NEO_UI_MAX_EVENT_BYTES) {
      return finish({ status: 'rejected', error: 'EVENT_BUDGET_EXCEEDED' });
    }
    const replay = this.repo.getEventReplay(event);
    if (replay?.kind === 'duplicate') {
      return finish({
        ...replay.result,
        status: 'duplicate',
        ...(replay.manifest ? { hostSurface: createHostSurface(replay.manifest) } : {}),
      });
    }
    if (replay?.kind === 'conflict') {
      return finish({ status: 'rejected', error: 'EVENT_IDEMPOTENCY_CONFLICT' });
    }

    const instance = this.repo.getById(event.instanceId);
    if (instance?.sessionId !== event.sessionId) {
      return finish({ status: 'rejected', error: 'INSTANCE_NOT_ACTIVE' });
    }
    if (instance.status !== 'active') {
      const result: NeoUIEventResultV1 = { status: 'rejected', error: 'INSTANCE_NOT_ACTIVE' };
      this.repo.insertEvent({ event, result });
      return finish(result);
    }
    if (instance.specHash !== event.specHash) {
      const result: NeoUIEventResultV1 = { status: 'rejected', error: 'SPEC_HASH_MISMATCH' };
      this.repo.insertEvent({ event, result });
      return finish(result);
    }
    const node = findNode(instance.spec, event.nodeId);
    if (!node || !declaresIntent(node, event.intent)) {
      const result: NeoUIEventResultV1 = { status: 'rejected', error: 'INTENT_NOT_DECLARED' };
      this.repo.insertEvent({ event, result });
      return finish(result);
    }

    if (event.intent === 'state.update') {
      const patch = isRecord(event.payload?.patch) ? event.payload.patch : null;
      if (!patch) {
        const result: NeoUIEventResultV1 = { status: 'rejected', error: 'INVALID_STATE_PATCH' };
        this.repo.insertEvent({ event, result });
        return finish(result);
      }
      const allowedRoots = allowedStateRoots(node);
      if (Object.keys(patch).some((key) => !allowedRoots.has(key))) {
        const result: NeoUIEventResultV1 = { status: 'rejected', error: 'STATE_PATCH_NOT_BOUND' };
        this.repo.insertEvent({ event, result });
        return finish(result);
      }
      const nextState = { ...instance.state, ...patch };
      if (new TextEncoder().encode(JSON.stringify(nextState)).length > NEO_UI_MAX_STATE_BYTES) {
        const result: NeoUIEventResultV1 = { status: 'rejected', error: 'STATE_BUDGET_EXCEEDED' };
        this.repo.insertEvent({ event, result });
        return finish(result);
      }
      return finish(this.repo.applyStateEvent(event, nextState, this.now()));
    }

    if (event.intent === 'operation.request') {
      if (!this.isManifestEnabled()) {
        const result: NeoUIEventResultV1 = { status: 'rejected', error: 'EXECUTION_MANIFEST_DISABLED' };
        this.repo.insertEvent({ event, result });
        return finish(result);
      }
      if (instance.stateRevision !== event.baseStateRevision) {
        const result: NeoUIEventResultV1 = { status: 'conflict', instance, error: 'STATE_REVISION_CONFLICT' };
        this.repo.insertEvent({ event, result });
        return finish(result);
      }
      const manifest = this.createDryRunManifest(instance, event);
      const result: NeoUIEventResultV1 = {
        status: 'applied',
        instance,
        hostSurface: createHostSurface(manifest),
      };
      this.repo.insertEvent({ event, result });
      return finish(result);
    }

    const result: NeoUIEventResultV1 = { status: 'applied', instance };
    this.repo.insertEvent({ event, result });
    return finish(result);
  }

  private createDryRunManifest(instance: NeoUIInstanceV1, event: NeoUIEventV1): ExecutionManifestV1 {
    const now = this.now();
    const itemSeed = {
      instanceId: instance.instanceId,
      nodeId: event.nodeId,
      specHash: instance.specHash,
      stateRevision: instance.stateRevision,
      label: safeText(event.payload?.label, 'Validate proposed operation'),
      summary: safeText(event.payload?.summary, 'Run a no-op safety validation.'),
      resourceRevision: safeText(event.payload?.resourceRevision, 'dry-run-v1', 128),
    };
    const itemScopeHash = sha256(JSON.stringify(itemSeed));
    const items: ExecutionManifestItemV1[] = [{
      id: `item_${randomUUID()}`,
      label: itemSeed.label,
      summary: itemSeed.summary,
      riskLevel: 'low',
      scopeHash: itemScopeHash,
      permissionBoundary: 'generative_ui.dry_run',
      resourceRevision: itemSeed.resourceRevision,
    }];
    const manifest: ExecutionManifestV1 = {
      schemaVersion: 1,
      manifestId: `manifest_${randomUUID()}`,
      sessionId: instance.sessionId,
      instanceId: instance.instanceId,
      origin: 'host',
      nonce: randomUUID(),
      scopeHash: sha256(items.map((item) => item.scopeHash).join(':')),
      title: safeText(event.payload?.title, 'Review execution scope'),
      summary: safeText(event.payload?.summary, 'Review the complete scope before approving.'),
      items,
      status: 'pending',
      expiresAt: now + MANIFEST_TTL_MS,
      createdAt: now,
      updatedAt: now,
    };
    return this.repo.insertManifest(manifest);
  }

  private refreshManifestForSurface(manifest: ExecutionManifestV1): ExecutionManifestV1 {
    if (manifest.status !== 'pending') return manifest;
    const now = this.now();
    if (!this.isManifestEnabled()) {
      return this.repo.updateManifest(
        manifest.manifestId,
        ['pending'],
        'invalidated',
        now,
        'FEATURE_DISABLED',
      ) ?? manifest;
    }
    if (manifest.expiresAt <= now) {
      return this.repo.updateManifest(
        manifest.manifestId,
        ['pending'],
        'expired',
        now,
        'TTL_EXPIRED',
      ) ?? manifest;
    }
    return manifest;
  }

  resolveManifest(request: NeoUIResolveManifestRequest): NeoUIResolveManifestResult {
    const manifest = this.repo.getManifest(request.manifestId);
    if (manifest?.sessionId !== request.sessionId || manifest?.nonce !== request.nonce) {
      throw new Error('MANIFEST_NOT_FOUND');
    }
    if (!this.isEnabled() || !this.isManifestEnabled()) {
      const invalidated = manifest.status === 'pending'
        ? this.repo.updateManifest(manifest.manifestId, ['pending'], 'invalidated', this.now(), 'FEATURE_DISABLED') ?? manifest
        : manifest;
      return { manifest: invalidated, accepted: false, error: 'EXECUTION_MANIFEST_DISABLED' };
    }
    if (manifest.status === 'completed' && request.decision === 'approve') {
      return { manifest, accepted: true };
    }
    if (manifest.status !== 'pending') {
      return { manifest, accepted: false, error: `MANIFEST_${manifest.status.toUpperCase()}` };
    }

    const now = this.now();
    if (manifest.expiresAt <= now) {
      const expired = this.repo.updateManifest(manifest.manifestId, ['pending'], 'expired', now, 'TTL_EXPIRED') ?? manifest;
      recordGenerativeUIOutcome({ phase: 'manifest', outcome: 'expired', reason: 'TTL_EXPIRED' });
      return { manifest: expired, accepted: false, error: 'MANIFEST_EXPIRED' };
    }
    if (request.decision === 'reject') {
      const rejected = this.repo.updateManifest(manifest.manifestId, ['pending'], 'rejected', now) ?? manifest;
      recordGenerativeUIOutcome({ phase: 'manifest', outcome: 'rejected' });
      return { manifest: rejected, accepted: false };
    }

    for (const item of manifest.items) {
      const currentRevision = this.resolveResourceRevision(item);
      if (currentRevision !== item.resourceRevision) {
        const invalidated = this.repo.updateManifest(
          manifest.manifestId,
          ['pending'],
          'invalidated',
          now,
          'RESOURCE_REVISION_DRIFT',
        ) ?? manifest;
        recordGenerativeUIOutcome({ phase: 'manifest', outcome: 'invalidated', reason: 'RESOURCE_REVISION_DRIFT' });
        return { manifest: invalidated, accepted: false, error: 'RESOURCE_REVISION_DRIFT' };
      }
    }

    const approvalClaim = this.repo.transitionManifest(manifest.manifestId, ['pending'], 'approved', now);
    if (!approvalClaim.changed) {
      const current = approvalClaim.manifest ?? manifest;
      return {
        manifest: current,
        accepted: current.status === 'completed',
        ...(current.status === 'completed' ? {} : { error: `MANIFEST_${current.status.toUpperCase()}` }),
      };
    }
    const executionClaim = this.repo.transitionManifest(manifest.manifestId, ['approved'], 'executing', now);
    if (!executionClaim.changed) {
      const current = executionClaim.manifest ?? approvalClaim.manifest ?? manifest;
      return { manifest: current, accepted: false, error: `MANIFEST_${current.status.toUpperCase()}` };
    }
    // P0 walking skeleton executes a Host-owned no-op adapter after the CAS claim.
    const completed = this.repo.updateManifest(manifest.manifestId, ['executing'], 'completed', now)
      ?? executionClaim.manifest
      ?? manifest;
    recordGenerativeUIOutcome({ phase: 'manifest', outcome: 'completed' });
    return {
      manifest: completed,
      accepted: completed.status === 'completed',
      ...(completed.status === 'completed' ? {} : { error: `MANIFEST_${completed.status.toUpperCase()}` }),
    };
  }
}

let service: GenerativeUIService | null = null;

export function getGenerativeUIService(): GenerativeUIService {
  if (!service) service = new GenerativeUIService();
  return service;
}

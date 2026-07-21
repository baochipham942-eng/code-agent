import { useEffect, useMemo, useRef } from 'react';
import type { SurfaceEvidenceCardV1 } from '@shared/contract/surfaceExecution';
import {
  invokeNativeCommandAction,
  isNativeCommandRuntimeAvailable,
  type NativePipControlAction,
  type NativePipControlsPayload,
} from '../services/nativeCommandFacade';
import { executeSurfaceExecutionControl } from '../services/surfaceExecutionController';
import { getSurfaceExecutionFrame } from '../services/surfaceExecutionClient';
import { listenTauriEvent } from '../services/tauriPluginFacade';
import { useSessionStore } from '../stores/sessionStore';
import {
  selectSurfaceExecutionRunSessionV1,
  useSurfaceExecutionStore,
  type SurfaceFrameViewStateV1,
} from '../stores/surfaceExecutionStore';
import {
  surfaceExecutionScopeKeyV1,
  type RendererSurfaceSessionProjectionV1,
  type SurfaceExecutionScopeV1,
} from '../utils/surfaceExecutionProjection';

const DATA_IMAGE_REF = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i;
const LOCAL_FILE_REF = /^(?:\/|[a-z]:[\\/])/i;
const OPAQUE_FRAME_REF = /^surface-frame:\/\/[a-zA-Z0-9._:-]+$/;
const UNSAFE_REF = /(?:surface-secret-canary|\[redacted(?:-binary|-path)?\])/i;
const PIP_CONTROL_ACTIONS = new Set<NativePipControlAction>([
  'pause', 'resume', 'takeover', 'stop',
]);

export interface SurfaceExecutionPipFrameV1 {
  scope: SurfaceExecutionScopeV1;
  scopeKey: string;
  surface: 'browser' | 'computer';
  assetRef: string;
  updatedAt: number;
  evidenceId?: string;
  state: RendererSurfaceSessionProjectionV1['session']['state'];
  availableControls: NativePipControlAction[];
}

interface SurfaceExecutionPipControlEventV1 {
  version: 1;
  scope: SurfaceExecutionScopeV1;
  action: NativePipControlAction;
}

export interface SurfaceExecutionPipSelectionInputV1 {
  currentConversationId: string | null;
  sessionsByScope: Record<string, RendererSurfaceSessionProjectionV1>;
  frameByScope: Record<string, SurfaceFrameViewStateV1>;
}

interface SurfaceExecutionPipRequestTokenV1 {
  generation: number;
  requestKey: string;
}

export interface SurfaceExecutionPipRequestFenceV1 {
  issue: (requestKey: string) => SurfaceExecutionPipRequestTokenV1;
  clear: () => void;
  isCurrent: (token: SurfaceExecutionPipRequestTokenV1) => boolean;
}

function isSafeEvidence(evidence: SurfaceEvidenceCardV1): boolean {
  return evidence.kind === 'screenshot'
    && evidence.inspection.captureState === 'captured'
    && evidence.redactionStatus === 'clean'
    && isReadableSurfacePipAssetRef(evidence.assetRef);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPipControlAction(value: unknown): value is NativePipControlAction {
  return typeof value === 'string' && PIP_CONTROL_ACTIONS.has(value as NativePipControlAction);
}

function pipControls(session: RendererSurfaceSessionProjectionV1): NativePipControlAction[] {
  return session.availableControls.filter(isPipControlAction);
}

function newestActiveSession(
  conversationId: string,
  sessionsByScope: Record<string, RendererSurfaceSessionProjectionV1>,
): RendererSurfaceSessionProjectionV1 | null {
  return selectSurfaceExecutionRunSessionV1(sessionsByScope, {
    conversationId,
    includeTerminal: false,
  });
}

function unsafeEvidenceAssetRefs(session: RendererSurfaceSessionProjectionV1): Set<string> {
  return new Set(session.evidence.flatMap((evidence) => (
    evidence.assetRef && !isSafeEvidence(evidence) ? [evidence.assetRef] : []
  )));
}

function frameStateCandidate(
  session: RendererSurfaceSessionProjectionV1,
  frame: SurfaceFrameViewStateV1 | undefined,
): SurfaceExecutionPipFrameV1 | null {
  if (frame?.status !== 'ready') return null;
  if (surfaceExecutionScopeKeyV1(frame.scope) !== surfaceExecutionScopeKeyV1(session.scope)) return null;
  const assetRef = frame.assetRef || frame.frameRef;
  if (!isReadableSurfacePipAssetRef(assetRef)) return null;
  if (unsafeEvidenceAssetRefs(session).has(assetRef)) return null;
  return {
    scope: session.scope,
    scopeKey: surfaceExecutionScopeKeyV1(session.scope),
    surface: session.session.surface,
    assetRef,
    updatedAt: frame.updatedAt ?? session.updatedAt,
    state: session.session.state,
    availableControls: pipControls(session),
  };
}

function evidenceCandidate(
  session: RendererSurfaceSessionProjectionV1,
): SurfaceExecutionPipFrameV1 | null {
  const evidence = [...session.evidence]
    .filter(isSafeEvidence)
    .sort((left, right) => (
      right.capturedAt - left.capturedAt || right.evidenceId.localeCompare(left.evidenceId)
    ))[0];
  if (!evidence?.assetRef) return null;
  return {
    scope: session.scope,
    scopeKey: surfaceExecutionScopeKeyV1(session.scope),
    surface: session.session.surface,
    assetRef: evidence.assetRef,
    updatedAt: evidence.capturedAt,
    evidenceId: evidence.evidenceId,
    state: session.session.state,
    availableControls: pipControls(session),
  };
}

function parsePipControlEvent(value: unknown): SurfaceExecutionPipControlEventV1 | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.scope)
    || !isPipControlAction(value.action)) return null;
  const scope = value.scope;
  if (!['conversationId', 'runId', 'agentId', 'surfaceSessionId'].every((field) => (
    typeof scope[field] === 'string' && String(scope[field]).trim().length > 0
  ))) return null;
  return {
    version: 1,
    scope: {
      conversationId: String(scope.conversationId),
      runId: String(scope.runId),
      agentId: String(scope.agentId),
      surfaceSessionId: String(scope.surfaceSessionId),
    },
    action: value.action,
  };
}

function allowedSurfaceExecutionPipControlV1(
  value: unknown,
  frame: SurfaceExecutionPipFrameV1 | null,
  session: RendererSurfaceSessionProjectionV1 | undefined,
): SurfaceExecutionPipControlEventV1 | null {
  const event = parsePipControlEvent(value);
  if (!event || !frame || !session || !session.writable || session.source === 'compat') return null;
  const eventKey = surfaceExecutionScopeKeyV1(event.scope);
  if (eventKey !== frame.scopeKey
    || eventKey !== surfaceExecutionScopeKeyV1(session.scope)
    || !session.availableControls.includes(event.action)) return null;
  return event;
}

export function isReadableSurfacePipAssetRef(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !UNSAFE_REF.test(value)
    && (DATA_IMAGE_REF.test(value) || LOCAL_FILE_REF.test(value) || OPAQUE_FRAME_REF.test(value));
}

export function selectSurfaceExecutionPipFrameV1(
  input: SurfaceExecutionPipSelectionInputV1,
): SurfaceExecutionPipFrameV1 | null {
  const conversationId = input.currentConversationId?.trim();
  if (!conversationId) return null;
  const session = newestActiveSession(conversationId, input.sessionsByScope);
  if (!session) return null;
  const scopeKey = surfaceExecutionScopeKeyV1(session.scope);
  return frameStateCandidate(session, input.frameByScope[scopeKey]) ?? evidenceCandidate(session);
}

export function createSurfaceExecutionPipRequestFenceV1(): SurfaceExecutionPipRequestFenceV1 {
  let generation = 0;
  let currentRequestKey: string | null = null;
  return {
    issue: (requestKey) => {
      generation += 1;
      currentRequestKey = requestKey;
      return { generation, requestKey };
    },
    clear: () => {
      generation += 1;
      currentRequestKey = null;
    },
    isCurrent: (token) => (
      token.generation === generation && token.requestKey === currentRequestKey
    ),
  };
}

export async function resolveSurfaceExecutionPipDataUrlV1(
  assetRef: string,
  readFile: (path: string) => Promise<string>,
): Promise<string | null> {
  if (!isReadableSurfacePipAssetRef(assetRef)) return null;
  const dataUrl = DATA_IMAGE_REF.test(assetRef) ? assetRef : await readFile(assetRef);
  return isReadableSurfacePipAssetRef(dataUrl) && DATA_IMAGE_REF.test(dataUrl) ? dataUrl : null;
}

function requestKey(frame: SurfaceExecutionPipFrameV1): string {
  return [frame.scopeKey, frame.assetRef, frame.updatedAt].join('\u001f');
}

function controlsPayload(
  frame: SurfaceExecutionPipFrameV1,
  controlRequest: ReturnType<typeof useSurfaceExecutionStore.getState>['controlByScope'][string] | undefined,
): NativePipControlsPayload {
  const request = controlRequest && isPipControlAction(controlRequest.action)
    ? { action: controlRequest.action, status: controlRequest.status }
    : undefined;
  return {
    version: 1,
    scope: frame.scope,
    surface: frame.surface,
    state: frame.state,
    availableControls: frame.availableControls,
    ...(request ? { controlRequest: request } : {}),
  };
}

/**
 * Keeps the native PiP aligned with the current conversation's latest active
 * Browser or Computer Surface Session. Persisted history remains in the
 * conversation, while terminal or unreadable live frames close the PiP.
 */
export function useSurfaceExecutionPip(): void {
  const currentConversationId = useSessionStore((state) => state.currentSessionId);
  const sessionsByScope = useSurfaceExecutionStore((state) => state.sessionsByScope);
  const frameByScope = useSurfaceExecutionStore((state) => state.frameByScope);
  const frame = useMemo(() => selectSurfaceExecutionPipFrameV1({
    currentConversationId,
    sessionsByScope,
    frameByScope,
  }), [currentConversationId, frameByScope, sessionsByScope]);
  const frameRequestKey = frame ? requestKey(frame) : null;
  const controlRequest = useSurfaceExecutionStore((state) => (
    frame ? state.controlByScope[frame.scopeKey] : undefined
  ));
  const controls = useMemo(() => (
    frame ? controlsPayload(frame, controlRequest) : null
  ), [controlRequest, frame]);
  const fenceRef = useRef(createSurfaceExecutionPipRequestFenceV1());
  const visibleRef = useRef(false);
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeFrameRef = useRef<SurfaceExecutionPipFrameV1 | null>(frame);
  const controlsRef = useRef<NativePipControlsPayload | null>(controls);
  activeFrameRef.current = frame;
  controlsRef.current = controls;

  useEffect(() => {
    if (!isNativeCommandRuntimeAvailable()) return;

    const enqueue = (command: () => Promise<void>): void => {
      commandQueueRef.current = commandQueueRef.current
        .catch(() => undefined)
        .then(command)
        .catch(() => undefined);
    };

    if (!frame || !frameRequestKey) {
      fenceRef.current.clear();
      enqueue(async () => {
        visibleRef.current = false;
        await invokeNativeCommandAction('hidePip');
      });
      return;
    }

    const token = fenceRef.current.issue(frameRequestKey);
    void resolveSurfaceExecutionPipDataUrlV1(frame.assetRef, async (assetRef) => {
      if (OPAQUE_FRAME_REF.test(assetRef)) {
        return (await getSurfaceExecutionFrame({
          version: 1,
          conversationId: frame.scope.conversationId,
          surfaceSessionId: frame.scope.surfaceSessionId,
          assetRef,
        })).dataUrl;
      }
      return invokeNativeCommandAction('readAppshotImageDataUrl', { path: assetRef });
    }).then((dataUrl) => {
      if (!dataUrl || !fenceRef.current.isCurrent(token)) return;
      enqueue(async () => {
        if (!fenceRef.current.isCurrent(token)) return;
        try {
          if (!visibleRef.current) {
            await invokeNativeCommandAction('showPip');
            if (!fenceRef.current.isCurrent(token)) return;
            visibleRef.current = true;
          }
          await invokeNativeCommandAction('framePip', { dataUrl });
          const currentControls = controlsRef.current;
          if (currentControls && surfaceExecutionScopeKeyV1(currentControls.scope) === frame.scopeKey) {
            await invokeNativeCommandAction('setPipControls', { controls: currentControls });
          }
        } catch {
          if (!fenceRef.current.isCurrent(token)) return;
          visibleRef.current = false;
          await invokeNativeCommandAction('hidePip').catch(() => undefined);
        }
      });
    }).catch(() => {
      if (!fenceRef.current.isCurrent(token)) return;
      enqueue(async () => {
        if (!fenceRef.current.isCurrent(token)) return;
        visibleRef.current = false;
        await invokeNativeCommandAction('hidePip');
      });
    });
  }, [frame, frameRequestKey]);

  useEffect(() => {
    if (!isNativeCommandRuntimeAvailable() || !controls) return;
    commandQueueRef.current = commandQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!visibleRef.current || controlsRef.current !== controls) return;
        await invokeNativeCommandAction('setPipControls', { controls });
      })
      .catch(() => undefined);
  }, [controls]);

  useEffect(() => {
    if (!isNativeCommandRuntimeAvailable()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenTauriEvent<SurfaceExecutionPipControlEventV1>(
      'surface-pip-control',
      ({ payload }) => {
        const selected = activeFrameRef.current;
        const session = selected
          ? useSurfaceExecutionStore.getState().getSession(selected.scope)
          : undefined;
        const event = allowedSurfaceExecutionPipControlV1(payload, selected, session);
        if (!event) return;
        void executeSurfaceExecutionControl({
          version: 1,
          conversationId: event.scope.conversationId,
          surfaceSessionId: event.scope.surfaceSessionId,
          action: event.action,
        }).catch(() => undefined);
      },
    ).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => () => {
    fenceRef.current.clear();
    if (!isNativeCommandRuntimeAvailable()) return;
    commandQueueRef.current = commandQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        visibleRef.current = false;
        await invokeNativeCommandAction('hidePip');
      })
      .catch(() => undefined);
  }, []);
}

import { useEffect, useRef } from 'react';
import type { AgentEventEnvelope, ArtifactWriteStartedData, ToolCall, ToolResult } from '@shared/contract';
import ipcService from '../services/ipcService';
import { openSurfaceForArtifact } from '../services/surfaceIntentDispatcher';
import { suppressSurfaceIntentForCurrentTurn } from '../services/surfaceIntentRuntime';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { artifactFollowKey, useArtifactFollowStore } from '../stores/artifactFollowStore';
import {
  artifactPathFromToolResult,
  artifactPathFromToolStart,
  createTrailingThrottle,
  decideArtifactFollowOpen,
  resolveFollowableArtifactPath,
  type TrailingThrottle,
} from '../utils/artifactFollow';

const COMPLETE_SETTLE_MS = 1_100;

interface FollowedCall {
  sessionId: string;
  toolName: string;
  path: string | null;
}

function workbenchInteractionRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="workbench-view-selector"]')?.parentElement ?? null;
}

export function useArtifactFollow(): void {
  const lastInteractionAtRef = useRef(0);
  const followedCallsRef = useRef(new Map<string, FollowedCall>());
  const refreshersRef = useRef(new Map<string, TrailingThrottle>());
  const completionTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const root = workbenchInteractionRoot();
      if (root && event.target instanceof Node && root.contains(event.target)) {
        lastInteractionAtRef.current = Date.now();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);

    const getRefresher = (sessionId: string, path: string): TrailingThrottle => {
      const key = artifactFollowKey(sessionId, path);
      const existing = refreshersRef.current.get(key);
      if (existing) return existing;
      const created = createTrailingThrottle(() => {
        const state = useArtifactFollowStore.getState();
        if (state.pausedSessionIds.has(sessionId)) return;
        useAppStore.getState().openPreview(path, { source: 'auto', activate: false });
      });
      refreshersRef.current.set(key, created);
      return created;
    };

    const beginFollow = (sessionId: string, toolCallId: string, toolName: string, path: string) => {
      if (sessionId !== useSessionStore.getState().currentSessionId) return;
      followedCallsRef.current.set(toolCallId, { sessionId, toolName, path });
      const key = artifactFollowKey(sessionId, path);
      const priorTimer = completionTimersRef.current.get(key);
      if (priorTimer) clearTimeout(priorTimer);
      completionTimersRef.current.delete(key);

      const appState = useAppStore.getState();
      const root = workbenchInteractionRoot();
      const focusInOtherWorkbenchView = Boolean(
        root?.contains(document.activeElement)
        && appState.activeWorkbenchTab !== `preview:${path}`,
      );
      const followState = useArtifactFollowStore.getState();
      const decision = decideArtifactFollowOpen({
        paused: followState.pausedSessionIds.has(sessionId),
        focusInOtherWorkbenchView,
        lastWorkbenchInteractionAt: lastInteractionAtRef.current,
        now: Date.now(),
      });

      let activated = false;
      if (decision.activate) {
        activated = openSurfaceForArtifact({
          artifact: { kind: 'file-preview', filePath: path },
          artifactSessionId: sessionId,
        }) !== null;
      }
      if (!activated) {
        suppressSurfaceIntentForCurrentTurn();
        appState.openPreview(path, { source: 'auto', activate: false });
      }
      followState.start({ sessionId, path, attention: !activated });
    };

    const settleFollow = (call: FollowedCall, result: ToolResult) => {
      const workingDirectory = useAppStore.getState().workingDirectory;
      const resultPath = artifactPathFromToolResult(result, workingDirectory);
      const path = resultPath ?? call.path;
      if (!path || call.sessionId !== useSessionStore.getState().currentSessionId) return;
      if (!call.path) beginFollow(call.sessionId, result.toolCallId, call.toolName, path);

      const refresher = getRefresher(call.sessionId, path);
      if (result.success) refresher.trigger();
      const key = artifactFollowKey(call.sessionId, path);
      const priorTimer = completionTimersRef.current.get(key);
      if (priorTimer) clearTimeout(priorTimer);
      const timer = setTimeout(() => {
        if (result.success) refresher.flush();
        useArtifactFollowStore.getState().complete(call.sessionId, path);
        completionTimersRef.current.delete(key);
      }, result.success ? COMPLETE_SETTLE_MS : 0);
      completionTimersRef.current.set(key, timer);
    };

    const unsubscribe = ipcService.on('agent:event', (event: AgentEventEnvelope) => {
      const currentSessionId = useSessionStore.getState().currentSessionId;
      const sessionId = event.sessionId ?? currentSessionId;
      if (!sessionId || sessionId !== currentSessionId) return;

      if (event.type === 'tool_call_start') {
        const toolCall = event.data as ToolCall;
        const path = artifactPathFromToolStart(toolCall, useAppStore.getState().workingDirectory);
        followedCallsRef.current.set(toolCall.id, { sessionId, toolName: toolCall.name, path });
        if (path) beginFollow(sessionId, toolCall.id, toolCall.name, path);
        return;
      }

      if (event.type === 'artifact_write_started') {
        const data = event.data as ArtifactWriteStartedData;
        const path = resolveFollowableArtifactPath(data.filePath, useAppStore.getState().workingDirectory);
        if (path) beginFollow(sessionId, data.toolCallId, data.toolName, path);
        return;
      }

      if (event.type === 'tool_progress') {
        const call = followedCallsRef.current.get(event.data.toolCallId);
        if (call?.path) getRefresher(call.sessionId, call.path).trigger();
        return;
      }

      if (event.type === 'tool_call_end') {
        const result = event.data as ToolResult;
        const call = followedCallsRef.current.get(result.toolCallId);
        if (!call) return;
        followedCallsRef.current.delete(result.toolCallId);
        settleFollow(call, result);
      }
    });

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      unsubscribe?.();
      refreshersRef.current.forEach((refresher) => refresher.cancel());
      completionTimersRef.current.forEach((timer) => clearTimeout(timer));
      refreshersRef.current.clear();
      completionTimersRef.current.clear();
      followedCallsRef.current.clear();
    };
  }, []);
}

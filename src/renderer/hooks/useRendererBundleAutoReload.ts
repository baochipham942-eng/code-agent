import { useEffect, useRef } from 'react';
import type { RendererBundleStatus } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore, type SessionState } from '../stores/taskStore';
import { createLogger } from '../utils/logger';
import {
  getRendererBundleAutoReloadBlockedReason,
  readLoadedRendererBundleStatus,
} from '../utils/rendererBundleActivation';

const logger = createLogger('RendererBundleAutoReload');

export const DEFAULT_RENDERER_BUNDLE_AUTO_RELOAD_POLL_MS = 60_000;
export const DEFAULT_RENDERER_BUNDLE_AUTO_RELOAD_IDLE_MS = 10_000;
export const DEFAULT_RENDERER_BUNDLE_AUTO_RELOAD_INITIAL_DELAY_MS = 15_000;

export interface RendererBundleAutoReloadOptions {
  enabled?: boolean;
  pollIntervalMs?: number;
  minIdleMs?: number;
  initialDelayMs?: number;
  reload?: () => void;
  now?: () => number;
}

interface RendererBundleAutoReloadRuntimeState {
  runningSessionCount: number;
  processingSessionCount: number;
  isProcessing: boolean;
  activeTaskCount: number;
  backgroundTaskCount: number;
}

function countActiveTaskStates(sessionStates: Record<string, SessionState>): number {
  return Object.values(sessionStates).filter((state) =>
    state.status === 'running' ||
    state.status === 'queued' ||
    state.status === 'cancelling' ||
    state.status === 'paused'
  ).length;
}

export function useRendererBundleAutoReload(options: RendererBundleAutoReloadOptions = {}): void {
  const {
    enabled = true,
    pollIntervalMs = DEFAULT_RENDERER_BUNDLE_AUTO_RELOAD_POLL_MS,
    minIdleMs = DEFAULT_RENDERER_BUNDLE_AUTO_RELOAD_IDLE_MS,
    initialDelayMs = DEFAULT_RENDERER_BUNDLE_AUTO_RELOAD_INITIAL_DELAY_MS,
  } = options;

  const runningSessionCount = useSessionStore((state) => state.runningSessionIds.size);
  const backgroundTaskCount = useSessionStore((state) => state.backgroundTasks.length);
  const processingSessionCount = useAppStore((state) => state.processingSessionIds.size);
  const isProcessing = useAppStore((state) => state.isProcessing);
  const activeTaskCount = useTaskStore((state) => countActiveTaskStates(state.sessionStates));

  const runtimeRef = useRef<RendererBundleAutoReloadRuntimeState>({
    runningSessionCount: 0,
    processingSessionCount: 0,
    isProcessing: false,
    activeTaskCount: 0,
    backgroundTaskCount: 0,
  });
  const lastInteractionAtRef = useRef(Date.now());
  const reloadedRef = useRef(false);
  const reloadRef = useRef<() => void>(() => {
    window.location.reload();
  });
  const nowRef = useRef<() => number>(() => Date.now());

  runtimeRef.current = {
    runningSessionCount,
    processingSessionCount,
    isProcessing,
    activeTaskCount,
    backgroundTaskCount,
  };
  reloadRef.current = options.reload ?? (() => window.location.reload());
  nowRef.current = options.now ?? (() => Date.now());

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const markInteraction = () => {
      lastInteractionAtRef.current = nowRef.current();
    };
    lastInteractionAtRef.current = nowRef.current();
    const listenerOptions: AddEventListenerOptions = { passive: true };
    window.addEventListener('keydown', markInteraction, listenerOptions);
    window.addEventListener('pointerdown', markInteraction, listenerOptions);
    window.addEventListener('touchstart', markInteraction, listenerOptions);
    window.addEventListener('input', markInteraction, listenerOptions);
    window.addEventListener('focusin', markInteraction, listenerOptions);
    window.addEventListener('dragstart', markInteraction, listenerOptions);
    document.addEventListener('visibilitychange', markInteraction, listenerOptions);
    return () => {
      window.removeEventListener('keydown', markInteraction);
      window.removeEventListener('pointerdown', markInteraction);
      window.removeEventListener('touchstart', markInteraction);
      window.removeEventListener('input', markInteraction);
      window.removeEventListener('focusin', markInteraction);
      window.removeEventListener('dragstart', markInteraction);
      document.removeEventListener('visibilitychange', markInteraction);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    let cancelled = false;

    const checkRendererBundleStatus = async () => {
      if (cancelled || reloadedRef.current) return;
      try {
        const status = await ipcService.invokeDomain<RendererBundleStatus>(
          IPC_DOMAINS.UPDATE,
          'rendererBundleStatus',
        );
        if (cancelled || reloadedRef.current) return;
        const loadedBundle = readLoadedRendererBundleStatus();
        const idleMs = Math.max(0, nowRef.current() - lastInteractionAtRef.current);
        const blockedReason = getRendererBundleAutoReloadBlockedReason({
          status,
          loadedBundle,
          focusedElement: document.activeElement,
          documentHidden: document.hidden,
          idleMs,
          minIdleMs,
          ...runtimeRef.current,
        });
        if (blockedReason === null) {
          reloadedRef.current = true;
          logger.info('Reloading renderer after hot-update activation became safe', {
            targetVersion: status.activeBundle?.version ?? null,
            targetContentHash: status.activeBundle?.contentHash ?? null,
          });
          reloadRef.current();
        } else if (blockedReason !== 'no-pending-renderer-bundle') {
          logger.debug('Renderer hot-update reload deferred', { blockedReason });
        }
      } catch (error) {
        logger.debug('Renderer bundle auto-reload status check unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const initialTimer = window.setTimeout(checkRendererBundleStatus, initialDelayMs);
    const intervalTimer = window.setInterval(checkRendererBundleStatus, pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(intervalTimer);
    };
  }, [enabled, initialDelayMs, minIdleMs, pollIntervalMs]);
}

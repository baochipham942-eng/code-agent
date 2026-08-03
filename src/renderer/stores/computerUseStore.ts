import type {
  ComputerSurfaceObservationResult,
  ComputerSurfaceState,
  DesktopActivityEvent,
  FrontmostContextSnapshot,
  NativeDesktopCapabilities,
  NativeDesktopCollectorStatus,
} from '../services/nativeDesktop';
import type { NativePermissionSnapshot } from '@shared/contract';

/**
 * Computer Use 页面会在二级页互斥时被整棵卸载。这个 module-level snapshot
 * 保留最近一次诊断结果，让再次进入时可以先画旧数据，再静默刷新 native 状态。
 */
export const COMPUTER_USE_SNAPSHOT_TTL_MS = 45_000;

export interface ComputerUseSnapshot {
  capturedAtMs: number;
  nativeAvailable: boolean;
  capabilities: NativeDesktopCapabilities | null;
  permissionSnapshot: NativePermissionSnapshot | null;
  collectorStatus: NativeDesktopCollectorStatus | null;
  frontmost: FrontmostContextSnapshot | null;
  recentEvents: DesktopActivityEvent[];
  surface: ComputerSurfaceState | null;
  observation: ComputerSurfaceObservationResult | null;
  desktopProviderError: string | null;
  observeError: string | null;
}

let computerUseSnapshot: ComputerUseSnapshot | null = null;
const listeners = new Set<() => void>();
let systemSettingsRefreshPending = false;

function emitSnapshotChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeComputerUseSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getComputerUseSnapshot(): ComputerUseSnapshot | null {
  return computerUseSnapshot;
}

export function setComputerUseSnapshot(next: ComputerUseSnapshot | null): void {
  computerUseSnapshot = next;
  emitSnapshotChange();
}

export function patchComputerUseSnapshot(patch: Partial<ComputerUseSnapshot>): void {
  if (!computerUseSnapshot) return;
  computerUseSnapshot = { ...computerUseSnapshot, ...patch };
  emitSnapshotChange();
}

/** Keep stale data available while forcing the next entry/focus refresh. */
export function invalidateComputerUseSnapshot(): void {
  if (!computerUseSnapshot) return;
  computerUseSnapshot = { ...computerUseSnapshot, capturedAtMs: 0 };
  emitSnapshotChange();
}

export function invalidateComputerUseSnapshotForSystemSettings(): void {
  if (!computerUseSnapshot) return;
  systemSettingsRefreshPending = true;
  invalidateComputerUseSnapshot();
}

export function isComputerUseSystemSettingsRefreshPending(): boolean {
  return systemSettingsRefreshPending;
}

export function consumeComputerUseSystemSettingsRefresh(): boolean {
  const pending = systemSettingsRefreshPending;
  systemSettingsRefreshPending = false;
  return pending;
}

export function isComputerUseSnapshotStale(
  snapshot: ComputerUseSnapshot | null,
  nowMs = Date.now(),
): boolean {
  if (!snapshot || !Number.isFinite(snapshot.capturedAtMs) || snapshot.capturedAtMs <= 0) {
    return true;
  }
  return nowMs - snapshot.capturedAtMs >= COMPUTER_USE_SNAPSHOT_TTL_MS;
}

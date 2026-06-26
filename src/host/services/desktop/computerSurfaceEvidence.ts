import type {
  ComputerSurfaceSnapshot,
  WorkbenchActionTrace,
} from '../../../shared/contract/desktop';
import {
  parseWindowLocalPointFromParams,
  roundPoint,
} from './backgroundCgEventBridge';

export function buildComputerSurfaceActionEvidenceSummary(
  trace: WorkbenchActionTrace,
  after: ComputerSurfaceSnapshot,
): string[] {
  const beforeApp = trace.before?.appName || 'unknown app';
  const beforeTitle = trace.before?.title || 'unknown window';
  const afterApp = after.appName || 'unknown app';
  const afterTitle = after.windowTitle || 'unknown window';
  const params = trace.params || {};
  const targetApp = typeof params.targetApp === 'string' ? params.targetApp : trace.before?.appName || null;
  const targetRole = typeof params.role === 'string' ? params.role : null;
  const targetName = typeof params.name === 'string' ? params.name : null;
  const targetAxPath = typeof params.axPath === 'string' ? params.axPath : null;
  const targetSelector = typeof params.selector === 'string' ? params.selector : null;
  const pid = typeof params.pid === 'number' ? params.pid : null;
  const windowId = typeof params.windowId === 'number' ? params.windowId : null;
  const windowLocalPoint = parseWindowLocalPointFromParams(params);
  return [
    `Before: ${beforeApp} · ${beforeTitle}`,
    `After: ${afterApp} · ${afterTitle}`,
    targetApp ? `Target app: ${targetApp}` : null,
    trace.mode === 'background_ax'
      ? `AX locator: ${[targetRole, targetName, targetAxPath || targetSelector].filter(Boolean).join(' · ') || 'unknown'}`
      : null,
    trace.mode === 'background_cgevent'
      ? `CGEvent window: ${[pid ? `pid ${pid}` : null, windowId ? `window ${windowId}` : null].filter(Boolean).join(' · ') || 'unknown'}`
      : null,
    trace.mode === 'background_cgevent' && windowLocalPoint
      ? `Window local point: ${roundPoint(windowLocalPoint.x)}, ${roundPoint(windowLocalPoint.y)}`
      : null,
  ].filter(Boolean) as string[];
}

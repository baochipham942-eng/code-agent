import type {
  SurfaceEvidenceCaptureContextV1,
  SurfaceTargetRefV1,
} from '../contract/surfaceExecution';
import { redactSurfaceExecutionValue } from './surfaceExecutionRedaction';

const MAX_ID_LENGTH = 240;
const MAX_LABEL_LENGTH = 500;
const MAX_URL_LENGTH = 2_000;
const MAX_VIEWPORT_EDGE = 100_000;
const MAX_DEVICE_SCALE_FACTOR = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const redacted = redactSurfaceExecutionValue(value);
  return typeof redacted === 'string' && redacted.trim()
    ? redacted.slice(0, maxLength)
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function safePositiveNumber(value: unknown, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum
    ? value
    : undefined;
}

function safeSourceUrl(value: unknown): string | undefined {
  const redacted = safeString(value, MAX_URL_LENGTH);
  if (!redacted) return undefined;
  try {
    const parsed = new URL(redacted);
    if (parsed.protocol === 'data:' || parsed.protocol === 'file:' || parsed.protocol === 'javascript:') {
      return undefined;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().slice(0, MAX_URL_LENGTH);
  } catch {
    return redacted.split(/[?#]/, 1)[0]?.slice(0, MAX_URL_LENGTH) || undefined;
  }
}

function projectBrowserTarget(value: Record<string, unknown>): SurfaceTargetRefV1 | undefined {
  const browserInstanceId = safeString(value.browserInstanceId, MAX_ID_LENGTH);
  const windowRef = safeString(value.windowRef, MAX_ID_LENGTH);
  const tabRef = safeString(value.tabRef, MAX_ID_LENGTH);
  const documentRevision = safeString(value.documentRevision, MAX_ID_LENGTH);
  if (!browserInstanceId || !windowRef || !tabRef || !documentRevision) return undefined;
  const frameRef = safeString(value.frameRef, MAX_ID_LENGTH);
  const origin = safeSourceUrl(value.origin);
  const title = safeString(value.title, MAX_LABEL_LENGTH);
  return {
    kind: 'browser',
    browserInstanceId,
    windowRef,
    tabRef,
    ...(frameRef ? { frameRef } : {}),
    ...(origin ? { origin } : {}),
    documentRevision,
    ...(title ? { title } : {}),
  };
}

function projectComputerTarget(value: Record<string, unknown>): SurfaceTargetRefV1 | undefined {
  const deviceId = safeString(value.deviceId, MAX_ID_LENGTH);
  const appName = safeString(value.appName, MAX_LABEL_LENGTH);
  const pid = safeInteger(value.pid);
  const windowRef = safeString(value.windowRef, MAX_ID_LENGTH);
  const windowRevision = safeString(value.windowRevision, MAX_ID_LENGTH);
  if (!deviceId || !appName || pid === undefined || !windowRef || !windowRevision) return undefined;
  const bundleId = safeString(value.bundleId, MAX_ID_LENGTH);
  const spaceId = safeString(value.spaceId, MAX_ID_LENGTH);
  const title = safeString(value.title, MAX_LABEL_LENGTH);
  return {
    kind: 'computer',
    deviceId,
    appName,
    ...(bundleId ? { bundleId } : {}),
    pid,
    windowRef,
    ...(spaceId ? { spaceId } : {}),
    windowRevision,
    ...(title ? { title } : {}),
  };
}

function projectTarget(value: unknown): SurfaceTargetRefV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'browser') return projectBrowserTarget(value);
  if (value.kind === 'computer') return projectComputerTarget(value);
  return undefined;
}

export function projectSurfaceEvidenceCaptureContextForExport(
  value: unknown,
): SurfaceEvidenceCaptureContextV1 | undefined {
  if (!isRecord(value)) return undefined;
  const target = projectTarget(value.target);
  if (!target) return undefined;
  const sourceUrl = safeSourceUrl(value.sourceUrl);
  let viewport: SurfaceEvidenceCaptureContextV1['viewport'];
  if (isRecord(value.viewport)) {
    const width = safePositiveNumber(value.viewport.width, MAX_VIEWPORT_EDGE);
    const height = safePositiveNumber(value.viewport.height, MAX_VIEWPORT_EDGE);
    const deviceScaleFactor = safePositiveNumber(
      value.viewport.deviceScaleFactor,
      MAX_DEVICE_SCALE_FACTOR,
    );
    if (width !== undefined && height !== undefined) {
      viewport = {
        width,
        height,
        ...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}),
      };
    }
  }
  return {
    target,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(viewport ? { viewport } : {}),
  };
}

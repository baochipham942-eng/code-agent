import { redactSurfaceExecutionValue } from './surfaceExecutionRedaction';

const RAW_SURFACE_METADATA_KEYS = new Set([
  'surfaceExecutionEventV1',
  'surfaceExecutionEventsV1',
  'surfaceExecutionSessionV1',
  'surfaceExecutionLedgerV1',
  'surfaceExecutionActionResultV1',
  'surfaceActionResultV1',
  'computerUseActionResultV1',
  'surfaceExecutionActionRequestV1',
  'surfaceActionRequestV1',
  'surfaceExecutionErrorV1',
  'surfaceObservationV1',
  'surfaceAccessGrantV1',
  'surfaceGrantV1',
  'accessGrant',
  'grant',
  'grantId',
  'grantRef',
  'authority',
  'authorityRef',
  'approval',
  'approvalToken',
  'secretRef',
  'secretRefs',
  'selector',
  'selectorFallback',
  'target',
  'activeTarget',
  'targetRef',
  'elementRef',
  'browserInstanceId',
  'windowRef',
  'tabRef',
  'documentRevision',
  'deviceId',
  'windowRevision',
  'profileDir',
  'profilePath',
  'userDataDir',
  'path',
  'imagePath',
  'screenshotPath',
  'downloadPath',
  'outputPath',
  'screenshotBase64',
  'screenshotData',
  'imageBase64',
  'imageData',
  'imageDataUrl',
  'base64Image',
  'image_base64',
  'cookie',
  'cookies',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'storageState',
  'cookieJar',
]);

const SURFACE_EXECUTION_AUTHORITY_MARKER_KEYS = new Set([
  'surfaceExecutionEventV1',
  'surfaceExecutionEventsV1',
  'surfaceExecutionSessionV1',
  'surfaceExecutionLedgerV1',
  'surfaceExecutionExportV1',
  'surfaceExecutionActionResultV1',
  'surfaceActionResultV1',
  'computerUseActionResultV1',
  'surfaceExecutionActionRequestV1',
  'surfaceActionRequestV1',
  'surfaceExecutionErrorV1',
  'surfaceObservationV1',
  'surfaceAccessGrantV1',
  'surfaceGrantV1',
  'surfaceProjectionMode',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function carriesSurfaceExecutionAuthority(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).some((key) => SURFACE_EXECUTION_AUTHORITY_MARKER_KEYS.has(key));
}

export function stripRawSurfaceExecutionExportFields(
  value: unknown,
  depth = 0,
  stripSurfaceAuthority?: boolean,
): unknown {
  if (depth > 8) return '[truncated]';
  const shouldStripSurfaceAuthority = stripSurfaceAuthority
    ?? (depth === 0 && carriesSurfaceExecutionAuthority(value));
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => (
      stripRawSurfaceExecutionExportFields(item, depth + 1, shouldStripSurfaceAuthority)
    ));
  }
  if (!isRecord(value)) return redactSurfaceExecutionValue(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (shouldStripSurfaceAuthority && RAW_SURFACE_METADATA_KEYS.has(key)) continue;
    if (
      key === 'reasoning'
      || key === 'reasoningContent'
      || key === 'reasoning_content'
      || key === 'thinking'
      || key === 'chainOfThought'
    ) continue;
    const redacted = redactSurfaceExecutionValue(child, key, depth + 1);
    output[key] = stripRawSurfaceExecutionExportFields(
      redacted,
      depth + 1,
      shouldStripSurfaceAuthority,
    );
  }
  return output;
}

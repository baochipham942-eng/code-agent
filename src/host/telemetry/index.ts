// ============================================================================
// Telemetry Module - Barrel Export
// ============================================================================

export { TelemetryCollector, getTelemetryCollector } from './telemetryCollector';
export { TelemetryStorage, getTelemetryStorage } from './telemetryStorage';
export { classifyIntent, evaluateOutcome } from './intentClassifier';
export { TelemetryService, getTelemetryService, withApprovalTrace } from './telemetryService';
export type { TelemetrySpan, TelemetryMetrics, SpanKind, SpanStatus, SpanEvent } from './telemetryService';
export { createTelemetryAdapter, recordHookSpan, recordMcpSpan } from './telemetryAdapter';
export {
  bindRunTraceContext,
  createChildRunTraceContext,
  createRunTraceContext,
  fingerprintRunWorkspace,
  getActiveRunTraceContext,
  restoreRunTraceContext,
  serializeRunTraceContext,
  withRunTraceContext,
} from './runTraceContext';
export type {
  CreateRunTraceContextInput,
  RunTraceContext,
  SerializedRunTraceContext,
} from './runTraceContext';

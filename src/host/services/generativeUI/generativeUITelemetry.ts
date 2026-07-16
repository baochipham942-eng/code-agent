import { getTelemetryService } from '../../telemetry/telemetryService';

type SafeGenerativeUIAttributes = {
  phase: 'admission' | 'event' | 'manifest';
  outcome: string;
  schemaVersion?: number;
  componentTypes?: string;
  intent?: string;
  reason?: string;
};

/**
 * Generative UI telemetry deliberately accepts only protocol metadata.
 * Specs, state, payloads, paths, labels, and resource identifiers cannot cross
 * this typed boundary.
 */
export function recordGenerativeUIOutcome(attributes: SafeGenerativeUIAttributes): void {
  const telemetry = getTelemetryService();
  const span = telemetry.startSpan('generative_ui', 'internal', {
    'generative_ui.phase': attributes.phase,
    'generative_ui.outcome': attributes.outcome.slice(0, 80),
    ...(attributes.schemaVersion === undefined ? {} : {
      'generative_ui.schema_version': attributes.schemaVersion,
    }),
    ...(attributes.componentTypes ? {
      'generative_ui.component_types': attributes.componentTypes.slice(0, 160),
    } : {}),
    ...(attributes.intent ? { 'generative_ui.intent': attributes.intent.slice(0, 80) } : {}),
    ...(attributes.reason ? { 'generative_ui.reason': attributes.reason.slice(0, 120) } : {}),
  });
  telemetry.endSpan(span.spanId, attributes.outcome === 'rejected' || attributes.outcome === 'failed' ? 'error' : 'ok');
}

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/shared/contract';
import {
  extractEventData,
  summarizeEvent,
} from '../../../src/host/telemetry/telemetryCollectorInternal';

describe('artifact locator telemetry persistence', () => {
  it('keeps the stale reason dogfood-visible without persisting locator content', () => {
    const event: AgentEvent = {
      type: 'artifact_locator',
      data: {
        state: 'stale',
        kind: 'document',
        reason: 'paragraph_fingerprint_drift',
      },
    };

    expect(summarizeEvent(event)).toBe(
      'Artifact locator stale: document/paragraph_fingerprint_drift',
    );
    expect(JSON.parse(extractEventData(event)!)).toEqual({
      state: 'stale',
      kind: 'document',
      reason: 'paragraph_fingerprint_drift',
    });
    expect(extractEventData(event)).not.toContain('excerpt');
    expect(extractEventData(event)).not.toContain('filePath');
  });
});

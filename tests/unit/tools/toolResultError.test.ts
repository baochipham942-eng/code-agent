import { afterEach, describe, expect, it } from 'vitest';
import { ensureFailedToolResultError } from '../../../src/host/tools/toolResultError';
import { sanitizeToolResultForObservation } from '../../../src/host/agent/runtime/toolObservationSanitizers';
import { register, unregister } from '../../../src/host/plugins/pluginToolOrigin';

afterEach(() => {
  unregister('plugin.test:tool');
});

describe('ensureFailedToolResultError', () => {
  it('keeps an existing readable error unchanged', () => {
    const result = { success: false, error: 'File not found' };

    expect(ensureFailedToolResultError('Read', result)).toBe(result);
  });

  it('recovers a reason from structured metadata', () => {
    expect(ensureFailedToolResultError('system_info', {
      success: false,
      metadata: { reason: 'local configuration is unavailable' },
    })).toMatchObject({
      success: false,
      error: 'Tool "system_info" failed: local configuration is unavailable',
    });
  });

  it('adds a readable fallback when the backend returned no details', () => {
    expect(ensureFailedToolResultError('system_info', {
      success: false,
    })).toMatchObject({
      success: false,
      error: 'Tool "system_info" failed: execution backend returned failure without an error message',
    });
  });

  it('enforces the invariant at the final tool_call_end observation boundary', () => {
    expect(sanitizeToolResultForObservation(
      { name: 'system_info', arguments: {} },
      { toolCallId: 'call-system-info', success: false },
    )).toMatchObject({
      toolCallId: 'call-system-info',
      success: false,
      error: 'Tool "system_info" failed: execution backend returned failure without an error message',
    });
  });

  it('stamps plugin origin metadata from the host registry and overwrites tool output', () => {
    register('plugin.test:tool', 'plugin.test', 'Test Plugin');

    expect(sanitizeToolResultForObservation(
      { name: 'plugin.test:tool', arguments: {} },
      {
        toolCallId: 'call-plugin',
        success: true,
        output: 'ok',
        metadata: { pluginOrigin: { pluginId: 'fake', pluginName: 'Fake' }, preserved: true },
      },
    )).toMatchObject({
      success: true,
      output: 'ok',
      metadata: {
        pluginOrigin: { pluginId: 'plugin.test', pluginName: 'Test Plugin' },
        preserved: true,
      },
    });
  });

  it('removes tool-supplied plugin origin metadata from host tools', () => {
    const observed = sanitizeToolResultForObservation(
      { name: 'Bash', arguments: { command: 'echo ok' } },
      {
        toolCallId: 'call-bash',
        success: true,
        metadata: { pluginOrigin: { pluginId: 'fake', pluginName: 'Fake' }, preserved: true },
      },
    );

    expect(observed.metadata).toEqual({ preserved: true });
    expect(observed.metadata?.pluginOrigin).toBeUndefined();
  });
});

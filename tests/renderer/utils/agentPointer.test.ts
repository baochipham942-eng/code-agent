import { describe, expect, it } from 'vitest';
import type { AgentPointerEvent, ToolCall } from '../../../src/shared/contract';
import { buildAgentPointerEvent } from '../../../src/renderer/utils/agentPointer';
import { parseAgentPointerNativeCursorCapability } from '../../../src/shared/utils/agentPointer';

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'tool-1',
    name: 'browser_action',
    arguments: {},
    ...overrides,
  };
}

describe('buildAgentPointerEvent', () => {
  it('strictly parses a production native cursor capability', () => {
    expect(parseAgentPointerNativeCursorCapability({
      enabled: true,
      status: 'native',
      provider: 'cua-driver',
      supportsSystemOverlay: true,
      reason: 'start_session_available',
      fallbackSurface: null,
      checkedAtMs: 123,
    })).toEqual({
      enabled: true,
      status: 'native',
      provider: 'cua-driver',
      supportsSystemOverlay: true,
      reason: 'start_session_available',
      fallbackSurface: null,
      checkedAtMs: 123,
    });
  });

  it.each([
    { status: 'native', provider: 'cua-driver', supportsSystemOverlay: true },
    { enabled: true, status: 'native', provider: 'cua-driver' },
    { enabled: 'true', status: 'native', provider: 'cua-driver', supportsSystemOverlay: true },
    { enabled: true, status: 'unknown', provider: 'cua-driver', supportsSystemOverlay: true },
    { enabled: true, status: ' native ', provider: 'cua-driver', supportsSystemOverlay: true },
    { enabled: true, status: 'native', provider: 'unknown', supportsSystemOverlay: true },
    { enabled: true, status: 'native', provider: ' cua-driver ', supportsSystemOverlay: true },
    { enabled: true, status: 'native', provider: 'cua-driver', supportsSystemOverlay: 'true' },
    { enabled: true, status: 'native', provider: 'cua-driver', supportsSystemOverlay: true, reason: 123 },
    { enabled: true, status: 'native', provider: 'cua-driver', supportsSystemOverlay: true, fallbackSurface: 'web' },
    { enabled: true, status: 'native', provider: 'cua-driver', supportsSystemOverlay: true, checkedAtMs: Number.NaN },
  ])('rejects a malformed native cursor capability: %o', (value) => {
    expect(parseAgentPointerNativeCursorCapability(value)).toBeNull();
  });

  it('builds a browser click pointer from a targetRef bounding box', () => {
    const event = buildAgentPointerEvent(makeToolCall({
      id: 'browser-click-1',
      name: 'browser_action',
      arguments: {
        action: 'click',
        targetRef: {
          refId: 'target-1',
          source: 'dom',
          name: 'Submit',
          boundingBox: { x: 100, y: 180, width: 50, height: 40 },
        },
      },
      result: {
        toolCallId: 'browser-click-1',
        success: true,
        output: 'ok',
        metadata: {
          traceId: 'trace-browser-click',
        },
      },
    }));

    expect(event).toMatchObject({
      id: 'agent-pointer-browser-click-1',
      surface: 'browser',
      tone: 'browser',
      phase: 'click',
      coordSpace: 'browserViewport',
      targetSource: 'targetRef',
      traceId: 'trace-browser-click',
      success: true,
    });
    expect(event?.point).toEqual({ x: 125, y: 200, unit: 'px' });
    expect(event?.targetLabel).toContain('Submit');
  });

  it('does not reuse a stale browser targetRef bounding box', () => {
    const event = buildAgentPointerEvent(makeToolCall({
      id: 'browser-click-stale',
      name: 'browser_action',
      arguments: {
        action: 'click',
        targetRef: {
          refId: 'target-1',
          name: 'Old Submit',
          boundingBox: { x: 100, y: 180, width: 50, height: 40 },
        },
      },
      result: {
        toolCallId: 'browser-click-stale',
        success: false,
        error: 'stale targetRef',
        metadata: {
          code: 'STALE_TARGET_REF',
          targetRef: {
            refId: 'target-1',
            stale: true,
          },
        },
      },
    }));

    expect(event).toMatchObject({
      phase: 'failed',
      coordSpace: 'surfacePreview',
      pointSource: 'fallback',
      pointFreshness: 'stale',
      targetSource: 'targetRef',
      success: false,
    });
    expect(event?.point).not.toEqual({ x: 125, y: 200, unit: 'px' });
  });

  it('builds a computer click pointer from AX frame metadata', () => {
    const event = buildAgentPointerEvent(makeToolCall({
      id: 'computer-ax-click',
      name: 'computer_use',
      arguments: {
        action: 'click',
        targetApp: 'Notes',
        axPath: '1.2',
      },
      result: {
        toolCallId: 'computer-ax-click',
        success: true,
        output: 'ok',
        metadata: {
          targetName: 'Send',
          targetAxFrame: { x: 20, y: 30, width: 80, height: 20, coordSpace: 'screen' },
        },
      },
    }));

    expect(event).toMatchObject({
      surface: 'computer',
      phase: 'click',
      coordSpace: 'screen',
      pointSource: 'axFrame',
      pointFreshness: 'fresh',
      targetSource: 'axPath',
      targetLabel: 'Send',
      success: true,
    });
    expect(event?.point).toEqual({ x: 60, y: 40, unit: 'px' });
  });

  it('reuses the strict native cursor parser in the pointer builder', () => {
    const valid = buildAgentPointerEvent(makeToolCall({
      id: 'computer-native-valid',
      name: 'computer_use',
      arguments: { action: 'click', x: 10, y: 20 },
      result: {
        toolCallId: 'computer-native-valid',
        success: true,
        metadata: {
          agentPointerNativeCursor: {
            enabled: true,
            status: 'native',
            provider: 'cua-driver',
            supportsSystemOverlay: true,
            reason: 'start_session_available',
            fallbackSurface: null,
            checkedAtMs: 123,
          },
        },
      },
    }));
    const malformed = buildAgentPointerEvent(makeToolCall({
      id: 'computer-native-malformed',
      name: 'computer_use',
      arguments: { action: 'click', x: 10, y: 20 },
      result: {
        toolCallId: 'computer-native-malformed',
        success: true,
        metadata: {
          agentPointerNativeCursor: {
            enabled: true,
            status: 'native',
            provider: 'cua-driver',
          },
        },
      },
    }));

    expect(valid?.nativeCursor).toMatchObject({
      enabled: true,
      status: 'native',
      provider: 'cua-driver',
      supportsSystemOverlay: true,
    });
    expect(malformed?.nativeCursor).toBeNull();
  });

  it('builds a blocked computer pointer from screen coordinates', () => {
    const event = buildAgentPointerEvent(makeToolCall({
      id: 'computer-click-1',
      name: 'computer_use',
      arguments: {
        action: 'click',
        x: 340,
        y: 220,
        targetApp: 'Finder',
      },
      result: {
        toolCallId: 'computer-click-1',
        success: false,
        error: 'permission denied',
        metadata: {
          targetApp: 'Finder',
          workbenchTrace: {
            id: 'trace-computer-click',
            mode: 'foreground_fallback',
          },
        },
      },
    }));

    expect(event).toMatchObject({
      surface: 'computer',
      tone: 'blocked',
      phase: 'failed',
      coordSpace: 'screen',
      targetSource: 'coordinate',
      targetLabel: 'Finder',
      traceId: 'trace-computer-click',
      success: false,
    });
    expect(event?.point).toEqual({ x: 340, y: 220, unit: 'px' });
  });

  it('does not show a pointer for read-only state checks', () => {
    expect(buildAgentPointerEvent(makeToolCall({
      id: 'computer-state-1',
      name: 'computer_use',
      arguments: { action: 'get_state' },
    }))).toBeNull();
  });

  it('prefers runtime pointer metadata when the tool result provides it', () => {
    const runtimeEvent: AgentPointerEvent = {
      id: 'runtime-pointer',
      surface: 'browser',
      tone: 'browser',
      phase: 'click',
      coordSpace: 'browserViewport',
      point: { x: 12, y: 34, unit: 'px' },
      targetLabel: 'runtime target',
      targetSource: 'selector',
      traceId: 'runtime-trace',
      success: true,
    };

    const event = buildAgentPointerEvent(makeToolCall({
      id: 'browser-click-runtime',
      name: 'browser_action',
      arguments: {
        action: 'click',
        selector: '#fallback',
      },
      result: {
        toolCallId: 'browser-click-runtime',
        success: true,
        output: 'ok',
        metadata: {
          agentPointerEvent: runtimeEvent,
        },
      },
    }));

    expect(event).toEqual(runtimeEvent);
  });

  it('keeps observe as a read pointer for surface screenshots', () => {
    const event = buildAgentPointerEvent(makeToolCall({
      id: 'computer-observe-1',
      name: 'computer_use',
      arguments: {
        action: 'observe',
        includeScreenshot: true,
      },
      result: {
        toolCallId: 'computer-observe-1',
        success: true,
        output: 'ok',
        metadata: {
          computerSurfaceSnapshot: {
            appName: 'Safari',
            screenshotPath: '/tmp/safari.png',
          },
        },
      },
    }));

    expect(event).toMatchObject({
      surface: 'computer',
      tone: 'computer',
      phase: 'read',
      coordSpace: 'surfacePreview',
      targetLabel: 'with screenshot',
    });
    expect(event?.point?.unit).toBe('percent');
  });
});

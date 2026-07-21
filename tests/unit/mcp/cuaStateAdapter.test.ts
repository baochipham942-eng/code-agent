import { describe, expect, it } from 'vitest';
import {
  CuaStateAdapter,
  type CuaDriverCallContext,
  type CuaDriverCallResult,
  type CuaDriverPort,
} from '../../../src/host/mcp/cuaStateAdapter';
import { requireSharp } from '../../../src/host/runtime/sharpRuntime';

const context: CuaDriverCallContext = {
  sessionId: 'session-1',
  toolCallId: 'tool-1',
};

function snapshot(
  id: string,
  elements: Array<Record<string, unknown>>,
  screenshotData = Buffer.from(`png-${id}`).toString('base64'),
): CuaDriverCallResult {
  return {
    success: true,
    structured: {
      pid: 42,
      window_id: 7,
      snapshot_id: id,
      screenshot_width: 200,
      screenshot_height: 100,
      elements,
    },
    screenshot: { data: screenshotData, mimeType: 'image/png' },
  };
}

function element(
  index: number,
  label: string,
  value?: string,
): Record<string, unknown> {
  return {
    element_index: index,
    element_token: `token:${index}`,
    role: 'AXTextField',
    label,
    ...(value !== undefined ? { value } : {}),
    frame: { x: 10, y: 10, w: 80, h: 20 },
    depth: 1,
  };
}

class FakeDriver implements CuaDriverPort {
  generation = 'cua-driver:1';
  appName = 'Notes';
  calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  observations: CuaDriverCallResult[] = [];
  observationGenerations: string[] = [];
  actionResult: CuaDriverCallResult = { success: true, output: 'ok' };

  async call(toolName: string, args: Record<string, unknown>): Promise<CuaDriverCallResult> {
    this.calls.push({ toolName, args });
    if (toolName === 'list_windows') {
      return {
        success: true,
        structured: {
          windows: [{
            pid: 42,
            window_id: 7,
            app_name: this.appName,
            title: 'Draft',
            bounds: { x: 1, y: 2, width: 300, height: 200 },
            is_on_screen: true,
            on_current_space: true,
          }],
        },
      };
    }
    if (toolName === 'get_window_state') {
      const nextGeneration = this.observationGenerations.shift();
      if (nextGeneration) this.generation = nextGeneration;
      const next = this.observations.shift();
      if (!next) throw new Error('missing fake observation');
      return next;
    }
    return this.actionResult;
  }

  getGeneration(): string | undefined {
    return this.generation;
  }
}

async function pngWithWhitePatch(left?: number, top?: number): Promise<string> {
  const width = 200;
  const height = 100;
  const pixels = Buffer.alloc(width * height * 3);
  if (left !== undefined && top !== undefined) {
    for (let y = top; y < Math.min(top + 24, height); y += 1) {
      for (let x = left; x < Math.min(left + 24, width); x += 1) {
        const offset = (y * width + x) * 3;
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
      }
    }
  }
  const sharp = requireSharp({ allowBareModule: true });
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return png.toString('base64');
}

async function observe(adapter: CuaStateAdapter) {
  const result = await adapter.execute({
    operation: 'observe',
    target: { pid: 42, windowId: 7 },
  }, context);
  if (result.response.operation !== 'observe') throw new Error('expected observe');
  return result.response.state;
}

describe('CuaStateAdapter', () => {
  it('lists roots through the same deep interface', async () => {
    const driver = new FakeDriver();
    const adapter = new CuaStateAdapter(driver);

    const result = await adapter.execute({ operation: 'list_roots' }, context);

    expect(result.response).toEqual({
      version: 1,
      operation: 'list_roots',
      roots: [{
        provider: 'cua-driver',
        pid: 42,
        windowId: 7,
        appName: 'Notes',
        title: 'Draft',
        bounds: { x: 1, y: 2, width: 300, height: 200 },
        isOnScreen: true,
        onCurrentSpace: true,
      }],
    });
  });

  it('maps public element refs to opaque provider tokens and returns a successor state', async () => {
    const driver = new FakeDriver();
    driver.observations.push(
      snapshot('snap-1', [element(9, 'Title', 'old')]),
      snapshot('snap-2', [element(3, 'Title', 'new')]),
    );
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: { kind: 'set_value', elementRef: 'e1', value: 'new' },
      expect: { kind: 'element_value_equals', elementRef: 'e1', value: 'new' },
    }, context);

    expect(driver.calls.find((call) => call.toolName === 'set_value')?.args).toMatchObject({
      pid: 42,
      window_id: 7,
      element_token: 'token:9',
      value: 'new',
    });
    expect(result.response.operation).toBe('act');
    if (result.response.operation !== 'act') return;
    expect(result.response.result).toMatchObject({
      delivery: 'confirmed',
      verification: 'satisfied',
      overall: 'succeeded',
      successorState: { hostRevision: 1 },
    });
  });

  it('does not deliver when the expectation is already true', async () => {
    const driver = new FakeDriver();
    driver.observations.push(snapshot('snap-1', [element(1, 'Title', 'ready')]));
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: { kind: 'set_value', elementRef: 'e1', value: 'ready' },
      expect: { kind: 'element_value_equals', elementRef: 'e1', value: 'ready' },
    }, context);

    expect(driver.calls.filter((call) => call.toolName === 'set_value')).toHaveLength(0);
    if (result.response.operation !== 'act') throw new Error('expected act');
    expect(result.response.result).toMatchObject({
      delivery: 'not_attempted',
      verification: 'preexisting',
      overall: 'succeeded',
    });
  });

  it.each([
    ['element_exists', { kind: 'element_exists', elementRef: 'e1' }],
    ['window_present', { kind: 'window_present' }],
  ] as const)('delivers click before verifying precursor-true %s expectations', async (
    _expectationKind,
    expectation,
  ) => {
    const driver = new FakeDriver();
    driver.observations.push(
      snapshot('before-click', [element(1, 'Submit')]),
      snapshot('after-click', [element(1, 'Submit')]),
    );
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
      expect: expectation,
    }, context);

    expect(driver.calls.map((call) => call.toolName)).toEqual([
      'list_windows',
      'get_window_state',
      'list_windows',
      'click',
      'get_window_state',
    ]);
    expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(1);
    if (result.response.operation !== 'act') throw new Error('expected act');
    expect(result.response.result).toMatchObject({
      delivery: 'confirmed',
      verification: 'satisfied',
      overall: 'succeeded',
    });
  });

  it('keeps a provider rejection ambiguous when the postcondition is satisfied', async () => {
    const driver = new FakeDriver();
    driver.observations.push(
      snapshot('before-rejected', [element(1, 'Title', 'old')]),
      snapshot('after-rejected', [element(1, 'Title', 'new')]),
    );
    driver.actionResult = {
      success: false,
      output: 'set_value failed: AXUIElementSetAttributeValue(AXValue) failed with error -25204',
    };
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: { kind: 'set_value', elementRef: 'e1', value: 'new' },
      expect: { kind: 'element_value_equals', elementRef: 'e1', value: 'new' },
    }, context);

    expect(driver.calls.filter((call) => call.toolName === 'set_value')).toHaveLength(1);
    if (result.response.operation !== 'act') throw new Error('expected act');
    expect(result.response.result).toMatchObject({
      delivery: 'rejected',
      verification: 'satisfied',
      overall: 'ambiguous',
      successorState: { hostRevision: 1 },
      error: { kind: 'provider_error' },
    });
  });

  it('invalidates a state after provider restart before delivery', async () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const driver = new FakeDriver();
      driver.observations.push(snapshot(`snap-${iteration}`, [element(1, 'Title')]));
      const adapter = new CuaStateAdapter(driver);
      const state = await observe(adapter);
      driver.generation = `cua-driver:${iteration + 2}`;

      const result = await adapter.execute({
        operation: 'act',
        stateId: state.stateId,
        mutation: { kind: 'click', elementRef: 'e1' },
      }, context);

      expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(0);
      if (result.response.operation !== 'act') throw new Error('expected act');
      expect(result.response.result.error?.kind).toBe('provider_restarted');
    }
  });

  it('rejects window-id reuse by another application before mutation delivery', async () => {
    const driver = new FakeDriver();
    driver.observations.push(snapshot('before-reuse', [element(1, 'Submit')]));
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);
    driver.appName = 'Terminal';

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
    }, context);

    if (result.response.operation !== 'act') throw new Error('expected act');
    expect(result.response.result).toMatchObject({
      delivery: 'not_attempted',
      overall: 'failed',
      error: { kind: 'state_conflict' },
    });
    expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(0);
  });

  it('rejects an observation whose provider generation changes in flight', async () => {
    const driver = new FakeDriver();
    driver.observations.push(snapshot('snap-race', [element(1, 'Title')]));
    driver.observationGenerations.push('cua-driver:2');
    const adapter = new CuaStateAdapter(driver);

    await expect(observe(adapter)).rejects.toThrow('generation changed during observation');
  });

  it('fails closed when the provider restarts during coordinate preflight', async () => {
    const driver = new FakeDriver();
    const image = await pngWithWhitePatch();
    driver.observations.push(snapshot('snap-1', [], image), snapshot('snap-2', [], image));
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);
    driver.observationGenerations.push('cua-driver:2');

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: {
        kind: 'click',
        point: { x: 25, y: 25, screenshotId: state.screenshotId ?? '' },
      },
    }, context);

    expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(0);
    if (result.response.operation !== 'act') throw new Error('expected act');
    expect(result.response.result.error?.kind).toBe('provider_restarted');
  });

  it('marks uncertain delivery ambiguous and never replays the mutation', async () => {
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const driver = new FakeDriver();
      driver.observations.push(
        snapshot(`before-${iteration}`, [element(1, 'Submit')]),
        snapshot(`after-${iteration}`, [element(1, 'Submit')]),
      );
      driver.actionResult = {
        success: false,
        error: 'Connection closed before response',
        deliveryUnknown: true,
      };
      const adapter = new CuaStateAdapter(driver);
      const state = await observe(adapter);

      const result = await adapter.execute({
        operation: 'act',
        stateId: state.stateId,
        mutation: { kind: 'click', elementRef: 'e1' },
        expect: { kind: 'text_present', text: 'Complete' },
      }, context);

      expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(1);
      if (result.response.operation !== 'act') throw new Error('expected act');
      expect(result.response.result).toMatchObject({
        delivery: 'unknown',
        overall: 'ambiguous',
        error: { kind: 'delivery_unknown' },
      });
    }
  });

  it('keeps unknown delivery ambiguous even when the postcondition is observed', async () => {
    const driver = new FakeDriver();
    driver.observations.push(
      snapshot('before', [element(1, 'Submit')]),
      snapshot('after', [element(1, 'Complete')]),
    );
    driver.actionResult = {
      success: false,
      error: 'Connection closed before response',
      deliveryUnknown: true,
    };
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
      expect: { kind: 'text_present', text: 'Complete' },
    }, context);

    expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(1);
    if (result.response.operation !== 'act') throw new Error('expected act');
    expect(result.response.result).toMatchObject({
      delivery: 'unknown',
      verification: 'satisfied',
      overall: 'ambiguous',
      successorState: { hostRevision: 1 },
      error: { kind: 'delivery_unknown' },
    });
  });

  it('fails a stale provider token without advancing the host revision or replaying', async () => {
    const driver = new FakeDriver();
    driver.observations.push(
      snapshot('before-stale-token', [element(1, 'Title', 'old')]),
      snapshot('after-stale-token', [element(1, 'Title', 'old')]),
    );
    driver.actionResult = {
      success: false,
      output: 'stale element_token: snapshot was superseded',
    };
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: { kind: 'set_value', elementRef: 'e1', value: 'new' },
      expect: { kind: 'element_value_equals', elementRef: 'e1', value: 'new' },
    }, context);

    expect(driver.calls.filter((call) => call.toolName === 'set_value')).toHaveLength(1);
    if (result.response.operation !== 'act') throw new Error('expected act');
    expect(result.response.result).toMatchObject({
      delivery: 'rejected',
      verification: 'unsatisfied',
      overall: 'failed',
      successorState: { hostRevision: 0 },
      error: { kind: 'stale_state' },
    });
  });

  it('fails closed when a coordinate screenshot changes during preflight', async () => {
    const driver = new FakeDriver();
    driver.observations.push(
      snapshot('snap-1', []),
      snapshot('snap-2', [], Buffer.from('different-invalid-png').toString('base64')),
    );
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: {
        kind: 'click',
        point: { x: 25, y: 25, screenshotId: state.screenshotId ?? '' },
      },
    }, context);

    expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(0);
    if (result.response.operation !== 'act') throw new Error('expected act');
    expect(result.response.result.error?.kind).toBe('state_conflict');
    expect(result.response.result.successorState?.stateId).toBeTruthy();
  });

  it('rejects an out-of-bounds point even when the screenshot is unchanged', async () => {
    const driver = new FakeDriver();
    driver.observations.push(snapshot('snap-1', []));
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: {
        kind: 'click',
        point: { x: 250, y: 25, screenshotId: state.screenshotId ?? '' },
      },
    }, context);

    expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(0);
    if (result.response.operation !== 'act') throw new Error('expected act');
    expect(result.response.result.error?.kind).toBe('invalid_request');
  });

  it('checks both endpoints of a drag during coordinate preflight', async () => {
    const driver = new FakeDriver();
    const before = await pngWithWhitePatch();
    const after = await pngWithWhitePatch(150, 40);
    driver.observations.push(snapshot('snap-1', [], before), snapshot('snap-2', [], after));
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: {
        kind: 'drag',
        point: { x: 20, y: 20, screenshotId: state.screenshotId ?? '' },
        toPoint: { x: 160, y: 50, screenshotId: state.screenshotId ?? '' },
        deliveryMode: 'foreground',
      },
    }, context);

    expect(driver.calls.filter((call) => call.toolName === 'drag')).toHaveLength(0);
    if (result.response.operation !== 'act') throw new Error('expected act');
    expect(result.response.result.error?.kind).toBe('state_conflict');
  });

  it('rejects an expectation ref that is not owned by the state', async () => {
    const driver = new FakeDriver();
    driver.observations.push(snapshot('snap-1', [element(1, 'Delete')]));
    const adapter = new CuaStateAdapter(driver);
    const state = await observe(adapter);

    const result = await adapter.execute({
      operation: 'act',
      stateId: state.stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
      expect: { kind: 'element_absent', elementRef: 'e404' },
    }, context);

    expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(0);
    if (result.response.operation !== 'act') throw new Error('expected act');
    expect(result.response.result.error?.kind).toBe('invalid_request');
  });

  it('rejects 150 superseded-state attempts without a wrong-target delivery', async () => {
    for (let iteration = 0; iteration < 150; iteration += 1) {
      const driver = new FakeDriver();
      driver.observations.push(
        snapshot(`old-${iteration}`, [element(1, 'Delete')]),
        snapshot(`new-${iteration}`, [element(2, 'Keep')]),
      );
      const adapter = new CuaStateAdapter(driver);
      const oldState = await observe(adapter);
      await observe(adapter);

      const result = await adapter.execute({
        operation: 'act',
        stateId: oldState.stateId,
        mutation: { kind: 'click', elementRef: 'e1' },
      }, context);

      expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(0);
      if (result.response.operation !== 'act') throw new Error('expected act');
      expect(result.response.result.error?.kind).toBe('stale_state');
    }
  });

  it('isolates states by conversation, native run, and agent owner', async () => {
    const driver = new FakeDriver();
    driver.observations.push(snapshot('agent-a', [element(1, 'Delete')]));
    const adapter = new CuaStateAdapter(driver);
    const ownerA: CuaDriverCallContext = {
      sessionId: 'shared-conversation',
      runId: 'run-1',
      agentId: 'agent-a',
      toolCallId: 'observe-a',
    };
    const ownerB: CuaDriverCallContext = {
      sessionId: 'shared-conversation',
      runId: 'run-1',
      agentId: 'agent-b',
      toolCallId: 'act-b',
    };

    const observed = await adapter.execute({
      operation: 'observe',
      target: { pid: 42, windowId: 7 },
    }, ownerA);
    if (observed.response.operation !== 'observe') throw new Error('expected observe');
    const stateId = observed.response.state.stateId;

    expect(adapter.getStateOwnership(stateId, ownerA)).toMatchObject({
      sessionId: 'shared-conversation',
      runId: 'run-1',
      agentId: 'agent-a',
      stateId,
      providerGeneration: 'cua-driver:1',
    });
    expect(adapter.getStateOwnership(stateId, ownerB)).toBeNull();

    const rejected = await adapter.execute({
      operation: 'act',
      stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
    }, ownerB);
    if (rejected.response.operation !== 'act') throw new Error('expected act');
    expect(rejected.response.result).toMatchObject({
      delivery: 'not_attempted',
      overall: 'failed',
      error: { kind: 'stale_state' },
    });
    expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(0);
  });

  it('isolates two Surface sessions owned by the same run and agent', async () => {
    const driver = new FakeDriver();
    driver.observations.push(snapshot('surface-a', [element(1, 'Delete')]));
    const adapter = new CuaStateAdapter(driver);
    const surfaceA: CuaDriverCallContext = {
      sessionId: 'shared-conversation',
      surfaceSessionId: 'surface-a',
      runId: 'run-1',
      agentId: 'agent-a',
      toolCallId: 'observe-a',
    };
    const surfaceB: CuaDriverCallContext = {
      ...surfaceA,
      surfaceSessionId: 'surface-b',
      toolCallId: 'act-b',
    };

    const observed = await adapter.execute({
      operation: 'observe',
      target: { pid: 42, windowId: 7 },
    }, surfaceA);
    if (observed.response.operation !== 'observe') throw new Error('expected observe');
    const rejected = await adapter.execute({
      operation: 'act',
      stateId: observed.response.state.stateId,
      mutation: { kind: 'click', elementRef: 'e1' },
    }, surfaceB);

    expect(adapter.getStateOwnership(observed.response.state.stateId, surfaceB)).toBeNull();
    if (rejected.response.operation !== 'act') throw new Error('expected act');
    expect(rejected.response.result.error?.kind).toBe('stale_state');
    expect(driver.calls.filter((call) => call.toolName === 'click')).toHaveLength(0);
  });
});

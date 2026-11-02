import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/host/tools/types';

const SECRET = 'hunter2-Zq9!fixture';
const NAME = 'CODE_AGENT_BROWSER_SECRET_TEST_PWD';
const ORIGINS = `${NAME}_ORIGINS`;

const mocks = vi.hoisted(() => {
  const state = { url: 'https://github.com/login' };
  const logs: string[] = [];
  const traces: unknown[] = [];
  const service = {
    logger: {
      log: vi.fn((level: string, message: string) => { logs.push(`${level} ${message}`); }),
      getLogsAsString: vi.fn(() => logs.join('\n')),
    },
    isRunning: vi.fn(() => true),
    getSessionState: vi.fn(() => ({ running: true, tabCount: 1, activeTab: { id: 'tab-1', url: state.url, title: 't' } })),
    getActiveTab: vi.fn(() => ({ id: 'tab-1', url: 'https://stale.example/cached', title: 't', page: { url: () => state.url } })),
    getLiveTabUrl: vi.fn(() => state.url),
    getPageContent: vi.fn(async () => ({ url: state.url, title: 't', text: 'plain page', links: [] })),
    getElementBoundingBox: vi.fn(async () => ({ x: 1, y: 2, width: 3, height: 4 })),
    type: vi.fn(async () => undefined),
    typeTargetRef: vi.fn(async () => ({ refId: 'tref_1', source: 'dom', selector: '#pw', name: 'Password', tabId: 'tab-1', snapshotId: 's1', capturedAtMs: 1 })),
    beginTrace: vi.fn((args: Record<string, unknown>) => ({ id: 'trace-1', targetKind: 'browser', mode: 'headless', startedAtMs: 1, before: null, ...args })),
    finishTrace: vi.fn((trace: Record<string, unknown>, args: Record<string, unknown>) => {
      const done = { ...trace, ...args };
      traces.push(done);
      return done;
    }),
  };
  return { state, logs, traces, service };
});

vi.mock('../../../../src/host/services/infra/browserService.js', () => ({
  browserService: mocks.service,
  redactBrowserWorkbenchTraceParams: (_t: string, params: Record<string, unknown>) => ({ ...params, secretRef: '[secretRef]' }),
}));
vi.mock('../../../../src/host/services/cloud/featureFlagService', () => ({ isComputerUseEnabled: () => true }));
vi.mock('../../../../src/host/services', () => ({ getConfigService: () => ({ onSettingsUpdated: vi.fn(), getApiKey: () => null }) }));

import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';
import { scrubSecretFromMessage } from '../../../../src/host/tools/vision/browserSecretRefGuard';

const context: ToolContext = {
  workingDirectory: '/tmp/x',
  requestPermission: async () => true,
  executionIntent: { browserSessionMode: 'managed', preferBrowserSession: true, allowBrowserAutomation: true },
};

async function typeSecret(extra: Record<string, unknown> = {}, secretRef = `env:${NAME}`) {
  return browserActionTool.execute({ action: 'type', selector: '#pw', secretRef, ...extra }, context);
}

function everything(result: unknown): string {
  return JSON.stringify([result, mocks.logs, mocks.traces]);
}

describe('browser secretRef guard', () => {
  beforeEach(() => {
    mocks.state.url = 'https://github.com/login';
    mocks.logs.length = 0;
    mocks.traces.length = 0;
    mocks.service.type.mockClear();
    mocks.service.typeTargetRef.mockClear();
    process.env[NAME] = SECRET;
    process.env[ORIGINS] = 'https://github.com, https://gist.github.com';
  });
  afterEach(() => {
    delete process.env[NAME];
    delete process.env[ORIGINS];
  });

  it('① a fill error quoting the secret never reaches result, logger or trace', async () => {
    mocks.service.type.mockRejectedValueOnce(new Error(`locator.fill: Element is not an <input>\nCall log:\n  - fill("${SECRET}")`));
    const result = await typeSecret();
    expect(result.success).toBe(false);
    expect(result.error).toContain('not editable');
    expect(result.error).toContain('selector #pw');
    expect(everything(result)).not.toContain(SECRET);

    mocks.service.typeTargetRef.mockRejectedValueOnce(new Error(`Timeout 30000ms exceeded. fill("${SECRET}")`));
    const byRef = await typeSecret({ selector: undefined, targetRef: 'tref_9' });
    expect(byRef.error).toContain('timeout');
    expect(byRef.error).toContain('targetRef tref_9');
    expect(everything(byRef)).not.toContain(SECRET);
  });

  it('① scrubSecretFromMessage masks the resolved value (outer catch belt and braces)', async () => {
    expect(scrubSecretFromMessage(`boom ${SECRET} boom`, `env:${NAME}`)).toBe('boom [secret] boom');
    expect(scrubSecretFromMessage(`boom ${SECRET}`, undefined)).toContain(SECRET);
  });

  it('② only CODE_AGENT_BROWSER_SECRET_* names resolve; _ORIGINS names are refused', async () => {
    process.env.PATH_LIKE_SECRET = 'x';
    for (const ref of ['env:PATH_LIKE_SECRET', 'env:HOME', `env:${ORIGINS}`, 'file:/etc/passwd', 'env:CODE_AGENT_BROWSER_SECRET_']) {
      mocks.service.type.mockClear();
      const result = await typeSecret({}, ref);
      expect(result.success).toBe(false);
      expect(result.error).toContain('CODE_AGENT_BROWSER_SECRET_');
      expect(result.error).toContain('.env');
      expect(mocks.service.type).not.toHaveBeenCalled();
    }
    delete process.env.PATH_LIKE_SECRET;
  });

  it('③ origin not listed, list missing, or IdP hop → nothing typed, needs-you result', async () => {
    mocks.state.url = 'https://login.idp.example/sso';
    const hop = await typeSecret();
    expect(hop.success).toBe(false);
    expect(hop.metadata).toMatchObject({ code: 'SECRET_REF_ORIGIN_MISMATCH', userActionRequired: true });
    expect(hop.error).toContain('This step needs you');
    expect(hop.error).toContain(ORIGINS);

    mocks.state.url = 'https://github.com/login';
    delete process.env[ORIGINS];
    const missing = await typeSecret();
    expect(missing.metadata).toMatchObject({ code: 'SECRET_REF_ORIGIN_MISMATCH', userActionRequired: true });
    expect(missing.error).toContain(`${ORIGINS} is not set`);

    expect(mocks.service.type).not.toHaveBeenCalled();
    expect(mocks.service.typeTargetRef).not.toHaveBeenCalled();
    expect(everything([hop, missing])).not.toContain(SECRET);
  });

  it('③ uses the live page url, not the cached tab url', async () => {
    const result = await typeSecret();
    expect(result.success).toBe(true);
    expect(mocks.service.type).toHaveBeenCalledWith('#pw', SECRET, undefined);
    expect(everything(result)).not.toContain(SECRET);
  });

  it('④ variable missing / not fillable legs give actionable sentences', async () => {
    delete process.env[NAME];
    const missing = await typeSecret();
    expect(missing.error).toContain(`${NAME} is not set`);
    expect(missing.error).toContain('.env');

    process.env[NAME] = SECRET;
    mocks.service.type.mockRejectedValueOnce(new Error('Element is not editable'));
    const notFillable = await typeSecret();
    expect(notFillable.error).toContain('not editable');
    expect(notFillable.error).toContain('get_dom_snapshot');
  });

  it('origin match is exact (lookalike host, scheme, port, non-http origins refused)', async () => {
    for (const url of ['https://github.com.evil.test/', 'http://github.com/', 'https://github.com:8443/', 'about:blank', 'data:text/html,x']) {
      mocks.state.url = url;
      const result = await typeSecret();
      expect(result.metadata).toMatchObject({ code: 'SECRET_REF_ORIGIN_MISMATCH' });
    }
    mocks.state.url = 'https://github.com/a?b=1';
    expect((await typeSecret()).success).toBe(true);
    expect(mocks.service.type).toHaveBeenCalledTimes(1);
  });
});

// 复现：web 域桥已经能把 POST /api/domain/voice/recordingOverview 送到
// registerVoiceHandlers。不改路由、不改注册函数。录音概览被 mock，不碰磁盘。
import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';

const getVoiceRecordingOverview = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/voice/voiceRecordingRetention', () => ({
  getVoiceRecordingOverview,
}));
vi.mock('../../../src/host/services/voice/voiceSessionService', () => ({
  injectVoiceUserText: vi.fn(),
}));
vi.mock('../../../src/host/services/voice/voiceFailurePersistence', () => ({
  persistVoiceCallFailure: vi.fn(),
}));
vi.mock('../../../src/host/services/voice/voiceprintService', () => ({
  clearVoiceprintData: vi.fn(),
  getVoiceprintOverview: vi.fn(),
  prepareVoiceprintModel: vi.fn(),
  registerVoiceprintFromActiveCall: vi.fn(),
}));

import { registerVoiceHandlers } from '../../../src/host/services/voice/voiceIpcContribution';
import { createDomainRouter } from '../../../src/web/routes/domain';

const RECORDING_OVERVIEW = {
  dir: '/tmp/voice-recordings-fixture',
  count: 2,
  totalBytes: 4096,
  lastCleanup: null,
  limits: { retentionDays: 30, maxBytes: 1_000_000, maxCalls: 20 },
};

const logger = { warn: vi.fn(), error: vi.fn() };

let server: http.Server | undefined;
let baseUrl = '';

function ipcMainStub(handlers: Map<string, WebRouteHandler>) {
  return {
    handle(channel: string, fn: WebRouteHandler) {
      handlers.set(channel, fn);
    },
  };
}

async function startApi(handlers: Map<string, WebRouteHandler>) {
  const app = express();
  app.use(express.json());
  app.use('/api', createDomainRouter({ handlers, logger }));
  server = await new Promise<http.Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function postRecordingOverview(): Promise<Response> {
  return fetch(`${baseUrl}/api/domain/voice/recordingOverview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'recordingOverview', requestId: 'req-recording-overview' }),
  });
}

beforeEach(() => {
  getVoiceRecordingOverview.mockReset();
  getVoiceRecordingOverview.mockResolvedValue(RECORDING_OVERVIEW);
  vi.clearAllMocks();
});

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
  server = undefined;
  baseUrl = '';
});

describe('voice recordingOverview domain bridge', () => {
  it('registerVoiceHandlers 写入 handlers 后 POST 返回 200 且 success 为 true', async () => {
    const handlers = new Map<string, WebRouteHandler>();
    registerVoiceHandlers(ipcMainStub(handlers) as never);
    expect(handlers.has('domain:voice')).toBe(true);
    await startApi(handlers);

    const response = await postRecordingOverview();
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: RECORDING_OVERVIEW });
    expect(getVoiceRecordingOverview).toHaveBeenCalledTimes(1);
    expect(getVoiceRecordingOverview).toHaveBeenCalledWith();
  });

  it('handlers 为空时 POST 返回 404 NOT_FOUND', async () => {
    await startApi(new Map());

    const response = await postRecordingOverview();
    const body: unknown = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'No handler for domain:voice action:recordingOverview',
      },
    });
    expect(getVoiceRecordingOverview).not.toHaveBeenCalled();
  });
});
